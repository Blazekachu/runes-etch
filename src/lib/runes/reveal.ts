// H7: This module accesses bitcoinjs-lib internals (__CACHE.__TX) for TXID computation
// and locktime setting. Pin bitcoinjs-lib to ^7.0.1 — do NOT upgrade without verifying
// that __CACHE.__TX still exists and Transaction.toBuffer() behavior is unchanged.
import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';
import { buildRunestoneScript } from './runestone';
import { buildFundingPsbtInput, type PsbtKeyMaterial } from './psbtInputs';
import { feeFromVSizeBigInt } from '@/lib/fees/feeFromVSize';
import { estimateRevealVBytes, scriptTypeForAddress } from './etchTxSize';
import type { RuneEtching, CommitTxState, ParentInscription, Utxo } from '@/types';

bitcoin.initEccLib(ecc);

// Taptree is not re-exported from the bitcoinjs-lib main entry point.
// Mirror the definition from bitcoinjs-lib/src/types.ts.
type Tapleaf = { output: Buffer; version?: number };
type Taptree = [Taptree | Tapleaf, Taptree | Tapleaf] | Tapleaf;

const DUST_LIMIT = 546n;

export interface FundingUtxoWithAddress extends Utxo {
  address: string;
}

export interface RevealTxParams {
  etching: RuneEtching;
  commitState: CommitTxState;
  tapscript: Uint8Array;
  controlBlock: Buffer;
  internalPubkey: Buffer;
  hasInscription: boolean;
  parentInscription: ParentInscription | null;
  additionalFundingUtxos: FundingUtxoWithAddress[];
  feeRate: number;
  receiverAddress: string;
  changeAddress: string;
  vanityNonce: Uint8Array;
  psbtKeys: PsbtKeyMaterial;
  /** nLockTime value for vanity TXID grinding. Ignored by consensus when all sequences are 0xffffffff. */
  locktime?: number;
  network?: bitcoin.Network;
}

export interface RevealTxResult {
  psbt: bitcoin.Psbt;
  estimatedTxid: string;
  estimatedVBytes: number;
  fee: number;
}

export function buildRevealTx(params: RevealTxParams): RevealTxResult {
  const {
    etching,
    commitState,
    tapscript,
    controlBlock,
    internalPubkey,
    hasInscription,
    parentInscription,
    additionalFundingUtxos,
    feeRate,
    receiverAddress,
    changeAddress,
    vanityNonce,
    psbtKeys,
    locktime = 0,
    network = bitcoin.networks.bitcoin,
  } = params;

  const psbt = new bitcoin.Psbt({ network });

  // Set nLockTime for vanity grinding (safe: all sequences default to 0xffffffff)
  if (locktime > 0) {
    const txObj = (psbt as unknown as { __CACHE: { __TX: bitcoin.Transaction } }).__CACHE.__TX;
    txObj.locktime = locktime;
  }

  // --- Derive commit output script (P2TR with tapscript as the single leaf) ---
  const scriptTree: Taptree = { output: Buffer.from(tapscript) };
  const { output: commitOutputScript } = bitcoin.payments.p2tr({
    internalPubkey,
    scriptTree,
    network,
  });
  if (!commitOutputScript) throw new Error('Failed to derive commit output script');

  // --- Input 0 for parent-child: Parent inscription UTXO ---
  // Ordinal sat assignment follows input order then output order. The parent
  // input must appear before the commit input, and the parent-return output
  // must appear before the child/rune output, or a dust parent can fall into
  // the fee tail.
  if (parentInscription) {
    const parentOutputScript = bitcoin.address.toOutputScript(parentInscription.address, network);
    psbt.addInput({
      hash: parentInscription.txid,
      index: parentInscription.vout,
      witnessUtxo: {
        script: parentOutputScript,
        value: BigInt(parentInscription.value),
      },
      tapInternalKey: internalPubkey,
    });
  }

  // --- Commit UTXO (script path spend) ---
  psbt.addInput({
    hash: commitState.txid,
    index: commitState.commitOutputIndex,
    witnessUtxo: {
      script: commitOutputScript,
      value: BigInt(commitState.commitOutputValue),
    },
    tapLeafScript: [
      {
        leafVersion: 0xc0,
        script: Buffer.from(tapscript),
        controlBlock: controlBlock,
      },
    ],
  });

  // --- Input 2+: Additional funding UTXOs ---
  // M10 FIX: Use each UTXO's actual address instead of assuming changeAddress
  for (const utxo of additionalFundingUtxos) {
    psbt.addInput(buildFundingPsbtInput(utxo, network, psbtKeys));
  }

  let outputIndex = 0;

  // --- Output 0 for parent-child: Parent return output ---
  // Parent is an inscription — return it to taproot/ordinals address before
  // any commit-input sats are allocated to child/rune/change outputs.
  if (parentInscription) {
    psbt.addOutput({
      address: receiverAddress,
      value: BigInt(parentInscription.value),
    });
    outputIndex++;
  }

  // --- Rune receiver output (always present) ---
  // In inscription mode: this is the inscription output at receiverAddress
  // In pure rune mode: dedicated dust output at receiverAddress
  // Ensures runes always land on the taproot/ordinals address, not the change address
  psbt.addOutput({
    address: receiverAddress,
    value: DUST_LIMIT,
  });
  const runeOutputIndex = outputIndex++;

  // --- OP_RETURN output: Runestone with etching data + vanity nonce ---
  const runestoneScript = buildRunestoneScript({
    etching,
    pointer: runeOutputIndex, // premined runes go to receiver output
    nonce: vanityNonce,
  });
  psbt.addOutput({
    script: Buffer.from(runestoneScript),
    value: BigInt(0),
  });

  // --- Fee estimation (typed change by address; re-estimate if change would be dust) ---
  const changeOutputType = scriptTypeForAddress(changeAddress);
  const fundingInputTypes = additionalFundingUtxos.map((u) => scriptTypeForAddress(u.address));

  const totalIn =
    BigInt(commitState.commitOutputValue) +
    (parentInscription ? BigInt(parentInscription.value) : 0n) +
    additionalFundingUtxos.reduce((acc, u) => acc + BigInt(u.value), 0n);

  const totalOut =
    DUST_LIMIT + // rune receiver output (always present)
    (parentInscription ? BigInt(parentInscription.value) : 0n) +
    0n; // OP_RETURN has value 0

  let estimatedVBytes = estimateRevealVBytes({
    tapscriptLen: tapscript.length,
    hasParent: !!parentInscription,
    numFundingUtxos: additionalFundingUtxos.length,
    fundingInputTypes,
    hasRuneOutput: true,
    changeOutput: changeOutputType,
    opReturnScriptLen: runestoneScript.length,
  });
  let fee = feeFromVSizeBigInt(estimatedVBytes, feeRate);
  let changeValue = totalIn - totalOut - fee;

  if (changeValue < 0n) {
    throw new Error(
      `Insufficient funds for reveal TX. Need ${totalOut + fee} sats, have ${totalIn} sats.`,
    );
  }

  if (changeValue >= DUST_LIMIT) {
    psbt.addOutput({
      address: changeAddress,
      value: changeValue,
    });
  } else {
    // Omit dust change; re-size fee for the 1-fewer-output tx.
    estimatedVBytes = estimateRevealVBytes({
      tapscriptLen: tapscript.length,
      hasParent: !!parentInscription,
      numFundingUtxos: additionalFundingUtxos.length,
      fundingInputTypes,
      hasRuneOutput: true,
      changeOutput: null,
      opReturnScriptLen: runestoneScript.length,
    });
    fee = feeFromVSizeBigInt(estimatedVBytes, feeRate);
    changeValue = totalIn - totalOut - fee;
    if (changeValue < 0n) {
      throw new Error(
        `Insufficient funds for reveal TX. Need ${totalOut + fee} sats, have ${totalIn} sats.`,
      );
    }
    // Any leftover below dust is absorbed into the miner fee (no safe fold target).
  }

  // --- Estimated TXID (from unsigned non-witness serialization) ---
  const nonWitnessBytes = serializeForTxid(psbt);
  const estimatedTxid = computeTxid(nonWitnessBytes);

  return {
    psbt,
    estimatedTxid,
    estimatedVBytes,
    fee: Number(fee),
  };
}

/**
 * Extracts the transaction from the PSBT and returns the non-witness
 * serialization used for TXID computation (matches Transaction.getId()).
 *
 * P2SH-P2WPKH inputs place the redeem script in scriptSig when signed; vanity
 * grinding must include that push up front or the grinded locktime won't match
 * the post-sign TXID.
 */
export function serializeForTxid(psbt: bitcoin.Psbt): Uint8Array {
  const txObj = (psbt as unknown as { __CACHE: { __TX: bitcoin.Transaction } }).__CACHE.__TX;
  if (!txObj) throw new Error('Cannot access raw transaction from PSBT cache');

  const tx = txObj.clone();
  for (let i = 0; i < psbt.data.inputs.length; i++) {
    const redeemScript = psbt.data.inputs[i].redeemScript;
    if (redeemScript && redeemScript.length > 0) {
      tx.setInputScript(i, bitcoin.script.compile([redeemScript]));
    }
  }

  return (tx as unknown as {
    __toBuffer: (buffer?: Uint8Array, initialOffset?: number, allowWitness?: boolean) => Uint8Array;
  }).__toBuffer(undefined, undefined, false);
}

/**
 * Computes the TXID: double-SHA256 of the non-witness serialization, reversed.
 */
export function computeTxid(nonWitnessBytes: Uint8Array): string {
  const hash1 = bitcoin.crypto.sha256(Buffer.from(nonWitnessBytes));
  const hash2 = bitcoin.crypto.sha256(hash1);
  // Reverse for display (little-endian → big-endian)
  const reversed = Buffer.from(hash2).reverse();
  return reversed.toString('hex');
}

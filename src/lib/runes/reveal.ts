// H7: This module accesses bitcoinjs-lib internals (__CACHE.__TX) for TXID computation
// and locktime setting. Pin bitcoinjs-lib to ^7.0.1 — do NOT upgrade without verifying
// that __CACHE.__TX still exists and Transaction.toBuffer() behavior is unchanged.
import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';
import { buildRunestoneScript } from './runestone';
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

  // --- Input 0: Commit UTXO (script path spend) ---
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

  // --- Input 1: Parent inscription UTXO (optional) ---
  // v2 FIX: use parent's actual address, not hardcoded changeAddress
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

  // --- Input 2+: Additional funding UTXOs ---
  // M10 FIX: Use each UTXO's actual address instead of assuming changeAddress
  for (const utxo of additionalFundingUtxos) {
    const fundingScript = bitcoin.address.toOutputScript(utxo.address, network);
    const isTaproot = utxo.address.startsWith('bc1p') || utxo.address.startsWith('tb1p');
    const input: Record<string, unknown> = {
      hash: utxo.txid,
      index: utxo.vout,
      witnessUtxo: {
        script: fundingScript,
        value: BigInt(utxo.value),
      },
    };
    // Only set tapInternalKey for P2TR inputs; P2WPKH inputs don't use it
    if (isTaproot) input.tapInternalKey = internalPubkey;
    psbt.addInput(input as unknown as Parameters<typeof psbt.addInput>[0]);
  }

  // --- Output 0: Rune receiver output (always present) ---
  // In inscription mode: this is the inscription output at receiverAddress
  // In no-inscription mode: dedicated dust output at receiverAddress
  // Ensures runes always land on the taproot/ordinals address, not the change address
  let outputIndex = 0;
  psbt.addOutput({
    address: receiverAddress,
    value: DUST_LIMIT,
  });
  const runeOutputIndex = outputIndex++;

  // --- Output: Parent return output (if parent present) ---
  // Parent is an inscription — return to taproot/ordinals address, not payment/change
  if (parentInscription) {
    psbt.addOutput({
      address: receiverAddress,
      value: DUST_LIMIT,
    });
    outputIndex++;
  }

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

  // --- Fee estimation ---
  const estimatedVBytes = estimateRevealVBytes(
    tapscript.length,
    true, // rune receiver output always present
    !!parentInscription,
    additionalFundingUtxos.length,
    runestoneScript.length,
  );
  const fee = BigInt(Math.ceil(estimatedVBytes * feeRate));

  // --- Change output ---
  const totalIn =
    BigInt(commitState.commitOutputValue) +
    (parentInscription ? BigInt(parentInscription.value) : 0n) +
    additionalFundingUtxos.reduce((acc, u) => acc + BigInt(u.value), 0n);

  const totalOut =
    DUST_LIMIT + // rune receiver output (always present)
    (parentInscription ? DUST_LIMIT : 0n) +
    0n; // OP_RETURN has value 0

  const changeValue = totalIn - totalOut - fee;
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
 * Extracts the unsigned transaction from the PSBT and returns the
 * non-witness serialization used for TXID computation.
 */
export function serializeForTxid(psbt: bitcoin.Psbt): Uint8Array {
  const tx = psbt.data.globalMap.unsignedTx;
  if (!tx) throw new Error('PSBT has no unsigned transaction');
  // bitcoinjs-lib PSBT stores the transaction as a Transaction object
  // accessible via psbt.txVersion etc.; use the Transaction serialization.
  const txObj = (psbt as unknown as { __CACHE: { __TX: bitcoin.Transaction } }).__CACHE.__TX;
  if (!txObj) throw new Error('Cannot access raw transaction from PSBT cache');
  // bypassSegwit = true gives legacy (non-witness) serialization for TXID
  return txObj.toBuffer();
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

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Estimates the virtual size (vbytes) of the reveal transaction.
 *
 * Segwit weight formula:  vbytes = ceil(weight / 4)
 *
 * Non-witness (base) bytes:
 *   - 4  version
 *   - 1  input count varint
 *   - 41 per input (outpoint 36 + sequence 4 + scriptSig len 1 = 41)
 *   - 1  output count varint
 *   - 43 per P2TR output (value 8 + scriptPubKey push 1 + OP_1 1 + push32 1 + 32 = 43)
 *   - OP_RETURN output: 8 (value) + variable script push
 *   - 4  locktime
 *
 * Witness bytes (weight 1 each):
 *   - 2  segwit marker+flag
 *   - commit input witness: script + control block + empty sig item
 *   - parent / funding inputs: 1 stack item (key-path sig, 65 bytes)
 *
 * This is an approximation consistent with commit.ts's estimateRevealVBytes.
 */
function estimateRevealVBytes(
  tapscriptLen: number,
  hasRuneOutput: boolean,
  hasParent: boolean,
  numFundingUtxos: number,
  opReturnScriptLen: number = 50,
): number {
  const numInputs = 1 + (hasParent ? 1 : 0) + numFundingUtxos;
  // Outputs = rune receiver (optional) + parent return (optional) + OP_RETURN + change
  const numOutputs = (hasRuneOutput ? 1 : 0) + (hasParent ? 1 : 0) + 1 + 1;

  // M2: Use actual OP_RETURN script size instead of hardcoded 50
  const opReturnOutputBytes = 8 + 1 + opReturnScriptLen; // value + scriptLen varint + script

  // Base (non-witness) weight
  const baseBytes =
    4 + // version
    1 + // input count
    numInputs * 41 + // inputs (no scriptSig for segwit)
    1 + // output count
    (numOutputs - 1) * 43 + // P2TR-sized outputs (excluding OP_RETURN)
    opReturnOutputBytes + // OP_RETURN output (actual size)
    4; // locktime

  // Witness weight (counted at 1 weight unit per byte)
  const witnessMarkerFlag = 2;

  // Commit input witness: [<sig placeholder 65>, <tapscript>, <controlBlock>]
  // Script path witnesses don't include a sig in the stack items pushed before
  // script — only the tapscript and control block are mandatory; the script
  // itself may push a dummy sig. We allocate 65 bytes for that.
  const commitWitnessBytes =
    1 + // stack item count
    1 + 65 + // dummy sig (length prefix + sig)
    3 + tapscriptLen + // tapscript (varint len up to 3 bytes + script)
    1 + 33; // control block (length prefix + 33-byte minimum control block)

  // Key-path inputs (parent + funding): one 65-byte schnorr sig each
  const keyPathWitnessPerInput = 1 + 1 + 65; // stack count + len + sig

  const witnessBytes =
    witnessMarkerFlag +
    commitWitnessBytes +
    (hasParent ? 1 : 0) * keyPathWitnessPerInput +
    numFundingUtxos * keyPathWitnessPerInput;

  // weight = base*4 + witness*1; vbytes = ceil(weight/4)
  const weight = baseBytes * 4 + witnessBytes;
  return Math.ceil(weight / 4);
}

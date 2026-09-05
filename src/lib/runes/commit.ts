import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';
import { buildTapscript, buildBareTapscript } from './inscription';
import { runeNameToCommitmentBytes } from './names';
import { buildFundingPsbtInput, type PsbtKeyMaterial } from './psbtInputs';
import { feeFromVSize, feeFromVSizeBigInt } from '@/lib/fees/feeFromVSize';
import {
  DEFAULT_RUNESTONE_SCRIPT_LEN,
  estimateCommitVBytes as estimateCommitVBytesTyped,
  estimateRevealVBytes as estimateRevealVBytesShared,
  estimateTapscriptLen,
  outputTypeForAddress,
  scriptTypeForAddress,
  type ScriptOutType,
} from './etchTxSize';
import type { InscriptionFile, ParentInscription, Utxo } from '@/types';

bitcoin.initEccLib(ecc);

// Taptree is not re-exported from the bitcoinjs-lib main entry point.
// Mirror the definition from bitcoinjs-lib/src/types.ts.
type Tapleaf = { output: Buffer; version?: number };
type Taptree = [Taptree | Tapleaf, Taptree | Tapleaf] | Tapleaf;

const DUST_LIMIT = 546n;

export interface FundingUtxo extends Utxo {
  address: string;
}

export interface CommitTxParams {
  runeName: string;
  inscriptionFile: InscriptionFile | null;  // null = bare commitment mode (unless delegateId)
  delegateId: string | null;                // delegate to existing inscription
  parentInscription: ParentInscription | null;
  fundingUtxos: FundingUtxo[];
  feeRate: number;
  /**
   * Reveal fee rate budget (sat/vB). Optional — defaults to feeRate when unset.
   * Sets the upper bound on what the reveal can pay. The commit allocates
   * `revealFeeRate × estimated_reveal_vbytes` worth of sats to commit.vout[0],
   * so the reveal can pay anywhere from 1 sat/vB up to revealFeeRate at sign time.
   * Excess (when reveal picks a lower rate) returns to the payment address as change.
   */
  revealFeeRate?: number;
  changeAddress: string;
  internalPubkey: Buffer;
  psbtKeys: PsbtKeyMaterial;
  network?: bitcoin.Network;
  /**
   * nLockTime value for vanity commit-TXID grinding. Ignored by consensus when all
   * input sequences are 0xffffffff (PSBT default), so it's safe to vary purely for
   * TXID grinding. Mirror of the reveal-side locktime field.
   */
  locktime?: number;
}

export interface CommitTxResult {
  psbt: bitcoin.Psbt;
  commitAddress: string;
  commitOutputValue: number;
  commitOutputIndex: number;
  tapscript: Uint8Array;
  tapLeafHash: Buffer;
  controlBlock: Buffer;
  scriptTree: Taptree;
  /**
   * Leftover that would have been dust change. After dust-fold this is normally 0
   * (leftover is added to commit.vout[0] and returns on reveal). Kept for UI
   * compatibility if a path still cannot preserve value.
   */
  dustChange: number;
}

export interface CommitFundingEstimate {
  revealVBytes: number;
  revealFee: number;
  runeOutputValue: number;
  parentReturnValue: number;
  revealChangeReserve: number;
  commitOutputValue: number;
  commitVBytes: number;
  commitFee: number;
  total: number;
}

export interface CommitFundingEstimateParams {
  contentSize: number;
  hasParent: boolean;
  parentValue?: number;
  commitFeeRate: number;
  revealFeeRate: number;
  numTaprootInputs: number;
  /** Native segwit (bc1q) funding inputs. */
  numSegwitInputs: number;
  /** Nested segwit (3…/2…) funding inputs. */
  numNestedSegwitInputs?: number;
  numCommitOutputs?: number;
  /** Payment/change address type for reveal + commit change sizing (default p2wpkh). */
  changeOutputType?: ScriptOutType;
  /** When known, prefer actual tapscript length over content-size estimate. */
  tapscriptLen?: number;
  hasInscription?: boolean;
  opReturnScriptLen?: number;
}

export function estimateCommitFunding(params: CommitFundingEstimateParams): CommitFundingEstimate {
  const changeOutputType = params.changeOutputType ?? 'p2wpkh';
  const hasInscription = params.hasInscription ?? params.contentSize > 0;
  const tapscriptLen =
    params.tapscriptLen ?? estimateTapscriptLen(params.contentSize, hasInscription);
  const revealVBytes = estimateRevealVBytesShared({
    tapscriptLen,
    hasParent: params.hasParent,
    numFundingUtxos: 0,
    hasRuneOutput: true,
    changeOutput: changeOutputType,
    opReturnScriptLen: params.opReturnScriptLen ?? DEFAULT_RUNESTONE_SCRIPT_LEN,
  });
  const revealFee = feeFromVSize(revealVBytes, params.revealFeeRate);
  const runeOutputValue = Number(DUST_LIMIT);
  const parentReturnValue = params.hasParent ? params.parentValue ?? Number(DUST_LIMIT) : 0;
  const revealChangeReserve = Number(DUST_LIMIT);
  const commitOutputValue = revealFee + runeOutputValue + revealChangeReserve;
  const hasChange = (params.numCommitOutputs ?? 2) >= 2;
  const commitVBytes = estimateCommitVBytesTyped({
    numTaprootInputs: params.numTaprootInputs,
    numSegwitInputs: params.numSegwitInputs,
    numNestedSegwitInputs: params.numNestedSegwitInputs ?? 0,
    changeOutput: hasChange ? changeOutputType : null,
  });
  const commitFee = feeFromVSize(commitVBytes, params.commitFeeRate);

  return {
    revealVBytes,
    revealFee,
    runeOutputValue,
    parentReturnValue,
    revealChangeReserve,
    commitOutputValue,
    commitVBytes,
    commitFee,
    total: commitOutputValue + commitFee,
  };
}

export function buildCommitTx(params: CommitTxParams): CommitTxResult {
  const {
    runeName, inscriptionFile, delegateId, parentInscription, fundingUtxos,
    feeRate, changeAddress, internalPubkey, psbtKeys,
    network = bitcoin.networks.bitcoin,
  } = params;
  const revealFeeRate = params.revealFeeRate ?? feeRate;

  const runeCommitment = runeNameToCommitmentBytes(runeName);

  // Build tapscript based on mode:
  // - inscriptionFile: full inscription with embedded content
  // - delegateId (no file): inscription envelope with delegate pointer (tiny)
  // - neither: bare commitment (no inscription)
  let tapscript: Uint8Array;
  if (inscriptionFile || delegateId) {
    tapscript = buildTapscript(internalPubkey, {
      contentType: inscriptionFile?.contentType ?? '',
      body: inscriptionFile?.body ?? new Uint8Array(0),
      parentId: parentInscription?.inscriptionId ?? null,
      delegateId,
      runeCommitment,
    });
  } else {
    tapscript = buildBareTapscript(internalPubkey, runeCommitment);
  }

  const tapscriptBuf = Buffer.from(tapscript);
  const scriptTree: Taptree = { output: tapscriptBuf };
  const { address: commitAddress, output: commitOutput } = bitcoin.payments.p2tr({
    internalPubkey,
    scriptTree,
    network,
  });

  if (!commitAddress || !commitOutput) throw new Error('Failed to derive commit P2TR address');

  const changeOutputType = outputTypeForAddress(changeAddress);
  // Always include a rune receiver output — runes need a non-OP_RETURN destination.
  // In inscription mode: this is the inscription output. In pure rune mode: dedicated dust output.
  // Reveal budget uses the (possibly higher) revealFeeRate — that's what gets
  // baked into commit.vout[0]. Reveal can pay 1..revealFeeRate at sign time;
  // any unspent budget returns to payment as change.
  const revealVBytes = estimateRevealVBytesShared({
    tapscriptLen: tapscript.length,
    hasParent: !!parentInscription,
    numFundingUtxos: 0,
    hasRuneOutput: true,
    changeOutput: changeOutputType,
    opReturnScriptLen: DEFAULT_RUNESTONE_SCRIPT_LEN,
  });
  const revealFee = feeFromVSizeBigInt(revealVBytes, revealFeeRate);
  const runeOutputValue = DUST_LIMIT; // rune receiver always present
  const revealChangeReserve = DUST_LIMIT;
  let commitOutputValue = revealFee + runeOutputValue + revealChangeReserve;

  const psbt = new bitcoin.Psbt({ network });

  // Set nLockTime for vanity grinding (safe: all input sequences stay 0xffffffff
  // by default, which disables locktime enforcement at consensus level).
  const locktime = params.locktime ?? 0;
  if (locktime > 0) {
    const txObj = (psbt as unknown as { __CACHE: { __TX: bitcoin.Transaction } }).__CACHE.__TX;
    txObj.locktime = locktime;
  }

  let totalInput = 0n;
  for (const utxo of fundingUtxos) {
    psbt.addInput(buildFundingPsbtInput(utxo, network, psbtKeys));
    totalInput += BigInt(utxo.value);
  }

  // Size inputs by actual address type (p2tr / native / nested)
  const inputTypes = fundingUtxos.map((u) => scriptTypeForAddress(u.address));

  // Estimate with 2 outputs first, then adjust if no change output
  let commitVBytes = estimateCommitVBytesTyped({
    inputTypes,
    changeOutput: changeOutputType,
  });
  let commitFee = feeFromVSizeBigInt(commitVBytes, feeRate);

  let changeValue = totalInput - commitOutputValue - commitFee;
  if (changeValue < 0n) {
    throw new Error(`Insufficient funds. Need ${commitOutputValue + commitFee} sats, have ${totalInput} sats.`);
  }

  if (changeValue >= DUST_LIMIT) {
    psbt.addOutput({ address: commitAddress, value: commitOutputValue });
    psbt.addOutput({ address: changeAddress, value: changeValue });
  } else {
    // No payment change — re-estimate with 1 output, then fold any leftover into
    // commit.vout[0] so it returns on reveal instead of being absorbed by miners.
    commitVBytes = estimateCommitVBytesTyped({
      inputTypes,
      changeOutput: null,
    });
    commitFee = feeFromVSizeBigInt(commitVBytes, feeRate);
    const leftover = totalInput - commitOutputValue - commitFee;
    if (leftover < 0n) {
      throw new Error(`Insufficient funds. Need ${commitOutputValue + commitFee} sats, have ${totalInput} sats.`);
    }
    if (leftover > 0n) {
      commitOutputValue += leftover;
    }
    psbt.addOutput({ address: commitAddress, value: commitOutputValue });
    changeValue = 0n;
  }

  const commitOutputIndex = 0;

  // TapLeaf hash: tagged hash of (leaf_version || compact_size(script) || script)
  const tapLeafHash = Buffer.from(
    bitcoin.crypto.taggedHash(
      'TapLeaf',
      Buffer.concat([
        Buffer.from([0xc0]),
        serializeScriptWithCompactSize(tapscriptBuf),
      ]),
    ),
  );

  // Derive control block via the redeem script path
  const redeemPayment = bitcoin.payments.p2tr({
    internalPubkey,
    scriptTree,
    redeem: { output: tapscriptBuf, redeemVersion: 0xc0 },
    network,
  });

  const controlBlockWitness = redeemPayment.witness;
  const controlBlock = controlBlockWitness && controlBlockWitness.length > 0
    ? Buffer.from(controlBlockWitness[controlBlockWitness.length - 1])
    : Buffer.alloc(0);

  // Dust fold above preserves leftover in commit out — dustChange stays 0.
  const dustChange = (changeValue > 0n && changeValue < DUST_LIMIT) ? Number(changeValue) : 0;

  return {
    psbt,
    commitAddress,
    commitOutputValue: Number(commitOutputValue),
    commitOutputIndex,
    tapscript,
    tapLeafHash,
    controlBlock,
    scriptTree,
    dustChange,
  };
}

/**
 * Encodes a script buffer with a compact-size (varint) length prefix,
 * as required by the TapLeaf tagged hash preimage.
 */
function serializeScriptWithCompactSize(script: Buffer): Buffer {
  const len = script.length;
  let prefix: Buffer;
  if (len < 0xfd) {
    prefix = Buffer.from([len]);
  } else if (len <= 0xffff) {
    prefix = Buffer.alloc(3);
    prefix[0] = 0xfd;
    prefix.writeUInt16LE(len, 1);
  } else {
    prefix = Buffer.alloc(5);
    prefix[0] = 0xfe;
    prefix.writeUInt32LE(len, 1);
  }
  return Buffer.concat([prefix, script]);
}

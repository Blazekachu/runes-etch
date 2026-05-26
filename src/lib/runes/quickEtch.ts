/**
 * Quick Etch TX builder — single transaction etch with no commit-reveal.
 * No inscription, no parent, no taproot script tree.
 * Just: funding inputs -> Runestone OP_RETURN + change.
 *
 * Risk: rune name is visible in mempool (no front-run protection).
 * Only safe for names that are fully unlocked (no commitment required).
 */

import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';
import { buildRunestoneScript } from './runestone';
import { minimumAtHeight, runeNameToU128 } from './names';
import type { RuneEtching } from '@/types';
import type { FundingUtxo } from './commit';

bitcoin.initEccLib(ecc);

const DUST_LIMIT = 546n;

export interface QuickEtchParams {
  etching: RuneEtching;
  fundingUtxos: FundingUtxo[];
  feeRate: number;
  receiverAddress: string;  // taproot — rune premine lands here
  changeAddress: string;    // payment — plain sats change
  internalPubkey: Buffer;
  vanityNonce: Uint8Array;
  currentBlockHeight: number;
  isTestnet?: boolean;
  /** nLockTime value for vanity TXID grinding. Safe when all sequences are 0xffffffff. */
  locktime?: number;
  network?: bitcoin.Network;
}

export interface QuickEtchResult {
  psbt: bitcoin.Psbt;
  estimatedVBytes: number;
  fee: number;
}

export function buildQuickEtchTx(params: QuickEtchParams): QuickEtchResult {
  const {
    etching,
    fundingUtxos,
    feeRate,
    receiverAddress,
    changeAddress,
    internalPubkey,
    vanityNonce,
    currentBlockHeight,
    isTestnet = false,
    locktime = 0,
    network = bitcoin.networks.bitcoin,
  } = params;

  // C2: Quick etch has no commitment. Names that still require commitment
  // (minimumAtHeight > 0 at current height) would produce a cenotaph.
  // The name must be fully unlocked — i.e., minimum is 0 (all names open)
  // OR the name's value is >= the current minimum.
  // Skip on testnet where block height is below runes activation.
  if (!isTestnet) {
    const nameValue = runeNameToU128(etching.runeName);
    const minValue = minimumAtHeight(currentBlockHeight);
    if (nameValue < minValue) {
      throw new Error(
        `Quick etch requires the name to be fully unlocked. "${etching.runeName}" still requires a commit-reveal. Use Full, No Parent, or No Inscription mode instead.`
      );
    }
  }

  const psbt = new bitcoin.Psbt({ network });

  // Set nLockTime for vanity grinding (safe: all sequences default to 0xffffffff)
  if (locktime > 0) {
    const txObj = (psbt as unknown as { __CACHE: { __TX: bitcoin.Transaction } }).__CACHE.__TX;
    txObj.locktime = locktime;
  }

  // Inputs: funding UTXOs
  let totalInput = 0n;
  for (const utxo of fundingUtxos) {
    const isTaproot = utxo.address.startsWith('bc1p') || utxo.address.startsWith('tb1p');
    const input: Record<string, unknown> = {
      hash: utxo.txid,
      index: utxo.vout,
      witnessUtxo: {
        script: bitcoin.address.toOutputScript(utxo.address, network),
        value: BigInt(utxo.value),
      },
    };
    if (isTaproot) input.tapInternalKey = internalPubkey;
    psbt.addInput(input as unknown as Parameters<typeof psbt.addInput>[0]);
    totalInput += BigInt(utxo.value);
  }

  // C3: If there's a premine, we MUST have a non-OP_RETURN output for runes to land on.
  // Add a dust output for the premine receiver if premine > 0.
  const hasPremine = etching.premine > 0n;
  let premineOutputIndex: number | null = null;
  let outputIndex = 0;

  if (hasPremine) {
    psbt.addOutput({
      address: receiverAddress,
      value: DUST_LIMIT,
    });
    premineOutputIndex = outputIndex++;
  }

  // Runestone OP_RETURN
  const runestoneScript = buildRunestoneScript({
    etching,
    pointer: premineOutputIndex,
    nonce: vanityNonce,
  });

  psbt.addOutput({
    script: Buffer.from(runestoneScript),
    value: 0n,
  });
  outputIndex++;

  // Estimate fee. Per-type sizing — accurate within ±5% of actual TX vsize.
  // Assumes a change output (taproot if any taproot input, else p2wpkh).
  // If real change ends up sub-dust and gets dropped, we overpay by ~31 vB
  // worth of fee — preferable to underpaying and ending up below min relay.
  const changeIsTaproot = fundingUtxos.some((u) =>
    u.address.startsWith('bc1p') || u.address.startsWith('tb1p'),
  );
  const inputDescs: EstimatorInput[] = fundingUtxos.map((u) => ({
    type: (u.address.startsWith('bc1p') || u.address.startsWith('tb1p')) ? 'p2tr' : 'p2wpkh',
  }));
  const outputDescs: EstimatorOutput[] = [];
  if (hasPremine) outputDescs.push({ type: 'p2tr' }); // receiverAddress is taproot
  outputDescs.push({ type: 'op_return', scriptByteLen: runestoneScript.length });
  outputDescs.push({ type: changeIsTaproot ? 'p2tr' : 'p2wpkh' });
  const estimatedVBytes = estimateQuickEtchVBytes(inputDescs, outputDescs);
  const fee = BigInt(Math.ceil(estimatedVBytes * feeRate));

  // Change output
  const premineReserve = hasPremine ? DUST_LIMIT : 0n;
  const changeValue = totalInput - fee - premineReserve;
  if (changeValue < 0n) {
    throw new Error(
      `Insufficient funds. Need ${fee + premineReserve} sats, have ${totalInput} sats.`
    );
  }
  if (changeValue >= DUST_LIMIT) {
    psbt.addOutput({
      address: changeAddress,
      value: changeValue,
    });
  } else if (!hasPremine && changeValue > 0n) {
    // No premine and sub-dust change — runes default to first non-OP_RETURN output.
    // Without any such output, runes burn. But if there's no premine, that's fine.
  }

  return {
    psbt,
    estimatedVBytes,
    fee: Number(fee),
  };
}

export type EstimatorInput = { type: 'p2wpkh' } | { type: 'p2tr' };
export type EstimatorOutput =
  | { type: 'p2wpkh' }
  | { type: 'p2tr' }
  | { type: 'op_return'; scriptByteLen: number };

// vsize contributions (BIP-141 witness discount: weight / 4):
//   tx overhead   = 10.5 vB (4 version + 1+1 in/out varints + 4 locktime + 0.5 marker/flag)
//   p2wpkh input  = 68 vB   (41-byte outpoint*4 weight + ~108 weight witness)
//   p2tr input    = 57.5 vB (41-byte outpoint*4 weight + 66 weight witness, key-path)
//   p2wpkh output = 31 vB   (8 value + 1 scriptlen + 22 script)
//   p2tr output   = 43 vB   (8 value + 1 scriptlen + 34 script)
//   op_return out = 9 + scriptByteLen vB (8 value + 1 scriptlen varint + script)
const TX_OVERHEAD_VB = 10.5;
const P2WPKH_IN_VB = 68;
const P2TR_IN_VB = 57.5;
const P2WPKH_OUT_VB = 31;
const P2TR_OUT_VB = 43;
const OP_RETURN_OUT_BASE_VB = 9; // + scriptByteLen

export function estimateQuickEtchVBytes(
  inputs: EstimatorInput[],
  outputs: EstimatorOutput[],
): number {
  let vb = TX_OVERHEAD_VB;
  for (const i of inputs) vb += i.type === 'p2tr' ? P2TR_IN_VB : P2WPKH_IN_VB;
  for (const o of outputs) {
    if (o.type === 'p2tr') vb += P2TR_OUT_VB;
    else if (o.type === 'p2wpkh') vb += P2WPKH_OUT_VB;
    else vb += OP_RETURN_OUT_BASE_VB + o.scriptByteLen;
  }
  return Math.ceil(vb);
}

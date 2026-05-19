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

  // Estimate fee (add 1 output for premine dust if applicable)
  const numOutputs = (hasPremine ? 1 : 0) + 1 /* OP_RETURN */ + 1 /* change */;
  const estimatedVBytes = estimateQuickEtchVBytes(fundingUtxos.length, numOutputs);
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

function estimateQuickEtchVBytes(numInputs: number, numOutputs: number): number {
  return Math.ceil(10.5 + numInputs * 57.5 + numOutputs * 43 + 50);
}

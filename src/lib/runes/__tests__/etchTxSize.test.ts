// @vitest-environment node

import { describe, expect, it } from 'vitest';
import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';
import { buildBareTapscript } from '../inscription';
import { runeNameToCommitmentBytes } from '../names';
import { buildCommitTx, estimateCommitFunding } from '../commit';
import { buildRevealTx } from '../reveal';
import {
  estimateRevealVBytes,
  fundingAddressForUtxo,
  isNestedSegwitAddress,
  isTaprootAddress,
  outputTypeForAddress,
  scriptTypeForAddress,
} from '../etchTxSize';
import { feeFromVSize } from '@/lib/fees/feeFromVSize';
import type { CommitTxState, RuneEtching } from '@/types';

bitcoin.initEccLib(ecc);

const network = bitcoin.networks.bitcoin;
const internalPubkey = Buffer.from(
  '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
  'hex',
);
const paymentKey = Buffer.from(
  '02' + '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
  'hex',
);
const paymentAddress = bitcoin.payments.p2wpkh({
  pubkey: paymentKey,
  network,
}).address!;
const nestedPaymentAddress = bitcoin.payments.p2sh({
  redeem: bitcoin.payments.p2wpkh({ pubkey: paymentKey, network }),
  network,
}).address!;
const taprootAddress = bitcoin.payments.p2tr({ internalPubkey, network }).address!;
const psbtKeys = {
  ordinalsInternalPubkey: internalPubkey,
  ordinalsAddress: taprootAddress,
  paymentAddress,
  paymentPublicKey: paymentKey,
};

describe('etchTxSize — VLOVE-shaped reveal', () => {
  it('sizes bare reveal with P2WPKH change near on-chain 192 vB', () => {
    const tapscript = buildBareTapscript(internalPubkey, runeNameToCommitmentBytes('VLOVE'));
    // VLOVE runestone was ~22 script bytes; use a close stand-in.
    const vb = estimateRevealVBytes({
      tapscriptLen: tapscript.length,
      hasParent: false,
      numFundingUtxos: 0,
      hasRuneOutput: true,
      changeOutput: 'p2wpkh',
      opReturnScriptLen: 22,
    });
    // Must not regress to the old 205 vB P2TR-change overestimate.
    expect(vb).toBeGreaterThanOrEqual(190);
    expect(vb).toBeLessThanOrEqual(196);
    expect(feeFromVSize(vb, 1.75)).toBe(Math.round(vb * 1.75));
  });

  it('detects native, nested, and taproot address types', () => {
    expect(scriptTypeForAddress(paymentAddress)).toBe('p2wpkh');
    expect(scriptTypeForAddress(nestedPaymentAddress)).toBe('p2sh-p2wpkh');
    expect(scriptTypeForAddress(taprootAddress)).toBe('p2tr');
    expect(outputTypeForAddress(paymentAddress)).toBe('p2wpkh');
  });

  // LabeledUtxos from mempool fetch historically omit `address`; UtxoSection must
  // still classify by wallet payment/taproot address (BuildButton already does this).
  it('fundingAddressForUtxo falls back to wallet address by source when UTXO.address is missing', () => {
    const wallet = { paymentAddress: nestedPaymentAddress, taprootAddress };
    expect(
      fundingAddressForUtxo({ source: 'payment' }, wallet),
    ).toBe(nestedPaymentAddress);
    expect(
      fundingAddressForUtxo({ source: 'taproot' }, wallet),
    ).toBe(taprootAddress);
    expect(
      fundingAddressForUtxo({ source: 'payment', address: paymentAddress }, wallet),
    ).toBe(paymentAddress);

    const resolved = fundingAddressForUtxo({ source: 'payment' }, wallet);
    expect(isNestedSegwitAddress(resolved)).toBe(true);
    expect(isTaprootAddress(resolved)).toBe(false);
  });

  it('sizes nested-segwit change differently from native', () => {
    const tapscript = buildBareTapscript(internalPubkey, runeNameToCommitmentBytes('VLOVE'));
    const native = estimateRevealVBytes({
      tapscriptLen: tapscript.length,
      hasParent: false,
      numFundingUtxos: 0,
      hasRuneOutput: true,
      changeOutput: 'p2wpkh',
      opReturnScriptLen: 22,
    });
    const nested = estimateRevealVBytes({
      tapscriptLen: tapscript.length,
      hasParent: false,
      numFundingUtxos: 0,
      hasRuneOutput: true,
      changeOutput: 'p2sh-p2wpkh',
      opReturnScriptLen: 22,
    });
    // Nested P2SH output is 1 vB larger than native P2WPKH (32 vs 31).
    expect(nested - native).toBe(1);
  });
});

describe('commit dust fold', () => {
  const etching: RuneEtching = {
    runeName: 'VLOVE',
    spacers: 0,
    symbol: 'V',
    divisibility: 0,
    premine: 0n,
    terms: null,
    turbo: false,
  };

  it('folds sub-dust leftover into commit.vout[0] instead of miner fee', () => {
    // Size a funding UTXO so 2-out change would be dust at 0.88 sat/vB.
    const estimate = estimateCommitFunding({
      contentSize: 0,
      hasParent: false,
      hasInscription: false,
      commitFeeRate: 0.88,
      revealFeeRate: 1.75,
      numTaprootInputs: 0,
      numSegwitInputs: 1,
      numCommitOutputs: 1,
      changeOutputType: 'p2wpkh',
    });
    // Exactly commitOut + fee1 + 40 dust leftover (classic VLOVE-shaped absorb).
    const funding = estimate.commitOutputValue + estimate.commitFee + 40;

    const commit = buildCommitTx({
      runeName: etching.runeName,
      inscriptionFile: null,
      delegateId: null,
      parentInscription: null,
      fundingUtxos: [{
        txid: 'a'.repeat(64),
        vout: 0,
        value: funding,
        status: { confirmed: true },
        address: paymentAddress,
      }],
      feeRate: 0.88,
      revealFeeRate: 1.75,
      changeAddress: paymentAddress,
      internalPubkey,
      psbtKeys,
      network,
    });

    expect(commit.dustChange).toBe(0);
    // Leftover folded into commit out (not lost).
    expect(commit.commitOutputValue).toBe(estimate.commitOutputValue + 40);

    const tx = (commit.psbt as unknown as { __CACHE: { __TX: bitcoin.Transaction } }).__CACHE.__TX;
    expect(tx.outs.length).toBe(1);
    expect(Number(tx.outs[0].value)).toBe(commit.commitOutputValue);
  });

  it('prices nested-segwit funding higher than native for the same commit', () => {
    const nativeEst = estimateCommitFunding({
      contentSize: 0,
      hasParent: false,
      hasInscription: false,
      commitFeeRate: 2,
      revealFeeRate: 2,
      numTaprootInputs: 0,
      numSegwitInputs: 1,
      numNestedSegwitInputs: 0,
      numCommitOutputs: 2,
      changeOutputType: 'p2wpkh',
    });
    const nestedEst = estimateCommitFunding({
      contentSize: 0,
      hasParent: false,
      hasInscription: false,
      commitFeeRate: 2,
      revealFeeRate: 2,
      numTaprootInputs: 0,
      numSegwitInputs: 0,
      numNestedSegwitInputs: 1,
      numCommitOutputs: 2,
      changeOutputType: 'p2sh-p2wpkh',
    });
    expect(nestedEst.commitVBytes).toBeGreaterThan(nativeEst.commitVBytes);
    expect(nestedEst.commitFee).toBeGreaterThan(nativeEst.commitFee);

    const nestedKeys = { ...psbtKeys, paymentAddress: nestedPaymentAddress };
    const commit = buildCommitTx({
      runeName: etching.runeName,
      inscriptionFile: null,
      delegateId: null,
      parentInscription: null,
      fundingUtxos: [{
        txid: 'd'.repeat(64),
        vout: 0,
        value: 50_000,
        status: { confirmed: true },
        address: nestedPaymentAddress,
      }],
      feeRate: 2,
      revealFeeRate: 2,
      changeAddress: nestedPaymentAddress,
      internalPubkey,
      psbtKeys: nestedKeys,
      network,
    });
    expect(commit.psbt.inputCount).toBe(1);
    expect(commit.psbt.data.inputs[0].redeemScript).toBeDefined();
  });

  it('commit and reveal share a coherent fee budget for bare etch', () => {
    const commit = buildCommitTx({
      runeName: etching.runeName,
      inscriptionFile: null,
      delegateId: null,
      parentInscription: null,
      fundingUtxos: [{
        txid: 'b'.repeat(64),
        vout: 0,
        value: 50_000,
        status: { confirmed: true },
        address: paymentAddress,
      }],
      feeRate: 1,
      revealFeeRate: 1.75,
      changeAddress: paymentAddress,
      internalPubkey,
      psbtKeys,
      network,
    });

    const commitState: CommitTxState = {
      txid: 'c'.repeat(64),
      rawHex: '',
      confirmations: 6,
      commitOutputIndex: commit.commitOutputIndex,
      commitOutputValue: commit.commitOutputValue,
      changeAddress: paymentAddress,
    };

    const reveal = buildRevealTx({
      etching,
      commitState,
      tapscript: commit.tapscript,
      controlBlock: commit.controlBlock,
      internalPubkey,
      hasInscription: false,
      parentInscription: null,
      additionalFundingUtxos: [],
      feeRate: 1.75,
      receiverAddress: taprootAddress,
      changeAddress: paymentAddress,
      vanityNonce: new Uint8Array(0),
      psbtKeys,
      network,
    });

    // Reveal fee must fit inside commit lock (fee budget + rune dust + reserve).
    expect(reveal.fee + 546 + 546).toBeLessThanOrEqual(commit.commitOutputValue);
    // Effective rate should be near target (within ~0.05 of rounding).
    const effective = reveal.fee / reveal.estimatedVBytes;
    expect(Math.abs(effective - 1.75)).toBeLessThan(0.06);
  });
});

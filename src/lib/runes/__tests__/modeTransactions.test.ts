// @vitest-environment node

import { describe, expect, it } from 'vitest';
import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';
import { buildCommitTx, estimateCommitFunding } from '../commit';
import { buildRevealTx } from '../reveal';
import type { CommitTxState, InscriptionFile, ParentInscription, RuneEtching } from '@/types';

bitcoin.initEccLib(ecc);

const network = bitcoin.networks.testnet;
const internalPubkey = Buffer.from('79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798', 'hex');
const paymentAddress = bitcoin.payments.p2wpkh({ hash: Buffer.alloc(20, 2), network }).address!;
const taprootAddress = bitcoin.payments.p2tr({ internalPubkey, network }).address!;
const psbtKeys = {
  ordinalsInternalPubkey: internalPubkey,
  ordinalsAddress: taprootAddress,
  paymentAddress,
};

const etching: RuneEtching = {
  runeName: 'TESTMODE',
  spacers: 0,
  symbol: 'T',
  divisibility: 0,
  premine: 1n,
  terms: {
    amount: 1n,
    cap: 10n,
    heightStart: null,
    heightEnd: null,
    offsetStart: null,
    offsetEnd: null,
  },
  turbo: false,
};

const inscriptionFile: InscriptionFile = {
  contentType: 'text/plain;charset=utf-8',
  body: new TextEncoder().encode('child'),
};

const parentInscription: ParentInscription = {
  inscriptionId: `${'a'.repeat(64)}i0`,
  txid: 'b'.repeat(64),
  vout: 1,
  value: 10_000,
  address: taprootAddress,
};

function commitStateFrom(result: ReturnType<typeof buildCommitTx>): CommitTxState {
  return {
    txid: 'c'.repeat(64),
    rawHex: '',
    confirmations: 6,
    commitOutputIndex: result.commitOutputIndex,
    commitOutputValue: result.commitOutputValue,
    changeAddress: paymentAddress,
  };
}

function txOutputCount(psbt: bitcoin.Psbt): number {
  return (psbt as unknown as { __CACHE: { __TX: bitcoin.Transaction } }).__CACHE.__TX.outs.length;
}

function txInputOutpoints(psbt: bitcoin.Psbt): string[] {
  const tx = (psbt as unknown as { __CACHE: { __TX: bitcoin.Transaction } }).__CACHE.__TX;
  return tx.ins.map((input) => `${Buffer.from(input.hash).reverse().toString('hex')}:${input.index}`);
}

function txOutputValues(psbt: bitcoin.Psbt): bigint[] {
  const tx = (psbt as unknown as { __CACHE: { __TX: bitcoin.Transaction } }).__CACHE.__TX;
  return tx.outs.map((output) => output.value);
}

describe('mode transaction shapes', () => {
  it('explains pure rune commit funding as reveal fee plus two dust reserves', () => {
    const estimate = estimateCommitFunding({
      contentSize: 0,
      hasParent: false,
      commitFeeRate: 1,
      revealFeeRate: 5,
      numTaprootInputs: 0,
      numSegwitInputs: 1,
      numCommitOutputs: 2,
    });

    expect(estimate.revealVBytes).toBe(247);
    expect(estimate.revealFee).toBe(1_235);
    expect(estimate.runeOutputValue).toBe(546);
    expect(estimate.revealChangeReserve).toBe(546);
    expect(estimate.commitOutputValue).toBe(2_327);
    expect(estimate.commitVBytes).toBe(165);
    expect(estimate.commitFee).toBe(165);
    expect(estimate.total).toBe(2_492);
  });

  it('parent-child commit funding excludes parent pass-through value', () => {
    const estimate = estimateCommitFunding({
      contentSize: 0,
      hasParent: true,
      parentValue: 10_000,
      commitFeeRate: 1,
      revealFeeRate: 5,
      numTaprootInputs: 0,
      numSegwitInputs: 1,
      numCommitOutputs: 2,
    });

    expect(estimate.parentReturnValue).toBe(10_000);
    expect(estimate.commitOutputValue).toBe(estimate.revealFee + estimate.runeOutputValue + estimate.revealChangeReserve);
    expect(estimate.commitOutputValue).not.toBeGreaterThanOrEqual(10_000);
  });

  it('parent-child reveal spends the parent and returns it to taproot', () => {
    const commit = buildCommitTx({
      runeName: etching.runeName,
      inscriptionFile,
      delegateId: null,
      parentInscription,
      fundingUtxos: [{
        txid: 'd'.repeat(64),
        vout: 0,
        value: 50_000,
        status: { confirmed: true },
        address: paymentAddress,
      }],
      feeRate: 2,
      changeAddress: paymentAddress,
      internalPubkey,
      psbtKeys,
      network,
    });

    const reveal = buildRevealTx({
      etching,
      commitState: commitStateFrom(commit),
      tapscript: commit.tapscript,
      controlBlock: commit.controlBlock,
      internalPubkey,
      hasInscription: true,
      parentInscription,
      additionalFundingUtxos: [],
      feeRate: 2,
      receiverAddress: taprootAddress,
      changeAddress: paymentAddress,
      vanityNonce: new Uint8Array(0),
      psbtKeys,
      network,
    });

    expect(reveal.psbt.inputCount).toBe(2);
    expect(txOutputCount(reveal.psbt)).toBe(4);
  });

  it('parent-child reveal keeps parent inscription out of the fee tail', () => {
    const parentDustInscription: ParentInscription = {
      ...parentInscription,
      value: 546,
    };
    const commitState: CommitTxState = {
      txid: 'c'.repeat(64),
      rawHex: '',
      confirmations: 6,
      commitOutputIndex: 0,
      commitOutputValue: 5_148,
      changeAddress: paymentAddress,
    };

    const reveal = buildRevealTx({
      etching,
      commitState,
      tapscript: Buffer.from('51', 'hex'),
      controlBlock: Buffer.concat([Buffer.from([0xc0]), internalPubkey]),
      internalPubkey,
      hasInscription: true,
      parentInscription: parentDustInscription,
      additionalFundingUtxos: [],
      feeRate: 2,
      receiverAddress: taprootAddress,
      changeAddress: paymentAddress,
      vanityNonce: new Uint8Array(0),
      psbtKeys,
      network,
    });

    expect(txInputOutpoints(reveal.psbt)[0]).toBe(`${parentDustInscription.txid}:${parentDustInscription.vout}`);
    expect(txInputOutpoints(reveal.psbt)[1]).toBe(`${commitState.txid}:${commitState.commitOutputIndex}`);
    expect(txOutputValues(reveal.psbt)[0]).toBe(546n);
    expect(txOutputValues(reveal.psbt)[1]).toBe(546n);
  });

  it.each([330, 546, 770, 10_000])(
    'parent-child reveal passes through a %i sat parent UTXO exactly',
    (parentValue) => {
      const sizedParent: ParentInscription = {
        ...parentInscription,
        value: parentValue,
      };
      const commitState: CommitTxState = {
        txid: 'c'.repeat(64),
        rawHex: '',
        confirmations: 6,
        commitOutputIndex: 0,
        commitOutputValue: 5_148,
        changeAddress: paymentAddress,
      };

      const reveal = buildRevealTx({
        etching,
        commitState,
        tapscript: Buffer.from('51', 'hex'),
        controlBlock: Buffer.concat([Buffer.from([0xc0]), internalPubkey]),
        internalPubkey,
        hasInscription: true,
        parentInscription: sizedParent,
        additionalFundingUtxos: [],
        feeRate: 2,
        receiverAddress: taprootAddress,
        changeAddress: paymentAddress,
        vanityNonce: new Uint8Array(0),
        network,
      });

      const values = txOutputValues(reveal.psbt);
      expect(values[0]).toBe(BigInt(parentValue));
      expect(values[1]).toBe(546n);
    },
  );

  it('rune-with-inscription reveal has no parent input or parent return output', () => {
    const commit = buildCommitTx({
      runeName: etching.runeName,
      inscriptionFile,
      delegateId: null,
      parentInscription: null,
      fundingUtxos: [{
        txid: 'e'.repeat(64),
        vout: 0,
        value: 50_000,
        status: { confirmed: true },
        address: paymentAddress,
      }],
      feeRate: 2,
      changeAddress: paymentAddress,
      internalPubkey,
      psbtKeys,
      network,
    });

    const reveal = buildRevealTx({
      etching,
      commitState: commitStateFrom(commit),
      tapscript: commit.tapscript,
      controlBlock: commit.controlBlock,
      internalPubkey,
      hasInscription: true,
      parentInscription: null,
      additionalFundingUtxos: [],
      feeRate: 2,
      receiverAddress: taprootAddress,
      changeAddress: paymentAddress,
      vanityNonce: new Uint8Array(0),
      psbtKeys,
      network,
    });

    expect(reveal.psbt.inputCount).toBe(1);
    expect(txOutputCount(reveal.psbt)).toBe(3);
  });

  it('pure rune reveal uses a bare commitment with no parent input', () => {
    const commit = buildCommitTx({
      runeName: etching.runeName,
      inscriptionFile: null,
      delegateId: null,
      parentInscription: null,
      fundingUtxos: [{
        txid: 'f'.repeat(64),
        vout: 0,
        value: 50_000,
        status: { confirmed: true },
        address: paymentAddress,
      }],
      feeRate: 2,
      changeAddress: paymentAddress,
      internalPubkey,
      psbtKeys,
      network,
    });

    const reveal = buildRevealTx({
      etching,
      commitState: commitStateFrom(commit),
      tapscript: commit.tapscript,
      controlBlock: commit.controlBlock,
      internalPubkey,
      hasInscription: false,
      parentInscription: null,
      additionalFundingUtxos: [],
      feeRate: 2,
      receiverAddress: taprootAddress,
      changeAddress: paymentAddress,
      vanityNonce: new Uint8Array(0),
      psbtKeys,
      network,
    });

    expect(reveal.psbt.inputCount).toBe(1);
    expect(txOutputCount(reveal.psbt)).toBe(3);
  });
});

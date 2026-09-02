// @vitest-environment node

import { describe, expect, it } from 'vitest';
import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';
import ECPairFactory from 'ecpair';
import { buildCommitTx } from '@/lib/runes/commit';
import { buildRevealTx, computeTxid, serializeForTxid } from '@/lib/runes/reveal';
import type { CommitTxState, RuneEtching } from '@/types';

bitcoin.initEccLib(ecc);
const ECPair = ECPairFactory(ecc);

const network = bitcoin.networks.testnet;
const keyPair = ECPair.fromPrivateKey(Buffer.from('0000000000000000000000000000000000000000000000000000000000000001', 'hex'));
const paymentKey = Buffer.from(keyPair.publicKey);
const internalPubkey = Buffer.from('c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709cb5', 'hex');
const p2wpkh = bitcoin.payments.p2wpkh({ pubkey: paymentKey, network });
const paymentAddress = p2wpkh.address!;
const p2shAddress = bitcoin.payments.p2sh({ redeem: p2wpkh, network }).address!;
const taprootAddress = bitcoin.payments.p2tr({ internalPubkey, network }).address!;
const psbtKeys = {
  ordinalsInternalPubkey: internalPubkey,
  ordinalsAddress: taprootAddress,
  paymentAddress: p2shAddress,
  paymentPublicKey: paymentKey,
};

const etching: RuneEtching = {
  runeName: 'AAAAAAAAAAAA',
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

function commitStateFrom(commit: ReturnType<typeof buildCommitTx>): CommitTxState {
  return {
    txid: 'c'.repeat(64),
    rawHex: '',
    confirmations: 6,
    commitOutputIndex: commit.commitOutputIndex,
    commitOutputValue: commit.commitOutputValue,
    changeAddress: p2shAddress,
  };
}

describe('reveal vanity template vs signed TXID', () => {
  it('pure rune reveal (current UI: no extra funding) matches grinder locktime', () => {
    const commit = buildCommitTx({
      runeName: etching.runeName,
      inscriptionFile: null,
      delegateId: null,
      parentInscription: null,
      fundingUtxos: [{ txid: 'd'.repeat(64), vout: 0, value: 50_000, address: p2shAddress }],
      feeRate: 2,
      changeAddress: p2shAddress,
      internalPubkey,
      psbtKeys,
      network,
    });

    const locktime = 0x00c0ffee;
    const template = serializeForTxid(buildRevealTx({
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
      changeAddress: p2shAddress,
      vanityNonce: new Uint8Array(0),
      psbtKeys,
      network,
      locktime: 0,
    }).psbt);
    const dv = new DataView(template.buffer, template.byteOffset, template.byteLength);
    dv.setUint32(template.length - 4, locktime, true);
    const predicted = computeTxid(template);

    const built = buildRevealTx({
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
      changeAddress: p2shAddress,
      vanityNonce: new Uint8Array(0),
      psbtKeys,
      network,
      locktime,
    });

    expect(computeTxid(serializeForTxid(built.psbt))).toBe(predicted);
    // Taproot script-path reveal input keeps scriptSig empty — unsigned TXID already final.
    const unsignedTx = (built.psbt as unknown as { __CACHE: { __TX: bitcoin.Transaction } }).__CACHE.__TX;
    expect(unsignedTx.getId()).toBe(predicted);
  });

  it('reveal with P2SH additional funding uses serializeForTxid redeem-script fix', () => {
    const commit = buildCommitTx({
      runeName: etching.runeName,
      inscriptionFile: null,
      delegateId: null,
      parentInscription: null,
      fundingUtxos: [{ txid: 'd'.repeat(64), vout: 0, value: 50_000, address: p2shAddress }],
      feeRate: 2,
      changeAddress: p2shAddress,
      internalPubkey,
      psbtKeys,
      network,
    });

    const locktime = 0x00beef00;
    const fundingUtxo = {
      txid: 'e'.repeat(64),
      vout: 1,
      value: 20_000,
      address: p2shAddress,
    };

    const template = serializeForTxid(buildRevealTx({
      etching,
      commitState: commitStateFrom(commit),
      tapscript: commit.tapscript,
      controlBlock: commit.controlBlock,
      internalPubkey,
      hasInscription: false,
      parentInscription: null,
      additionalFundingUtxos: [fundingUtxo],
      feeRate: 2,
      receiverAddress: taprootAddress,
      changeAddress: p2shAddress,
      vanityNonce: new Uint8Array(0),
      psbtKeys,
      network,
      locktime: 0,
    }).psbt);
    const dv = new DataView(template.buffer, template.byteOffset, template.byteLength);
    dv.setUint32(template.length - 4, locktime, true);
    const predicted = computeTxid(template);

    const built = buildRevealTx({
      etching,
      commitState: commitStateFrom(commit),
      tapscript: commit.tapscript,
      controlBlock: commit.controlBlock,
      internalPubkey,
      hasInscription: false,
      parentInscription: null,
      additionalFundingUtxos: [fundingUtxo],
      feeRate: 2,
      receiverAddress: taprootAddress,
      changeAddress: p2shAddress,
      vanityNonce: new Uint8Array(0),
      psbtKeys,
      network,
      locktime,
    });

    expect(computeTxid(serializeForTxid(built.psbt))).toBe(predicted);
    const unsignedTx = (built.psbt as unknown as { __CACHE: { __TX: bitcoin.Transaction } }).__CACHE.__TX;
    expect(unsignedTx.getId()).not.toBe(predicted);
  });
});

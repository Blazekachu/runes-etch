// @vitest-environment node

import { describe, expect, it } from 'vitest';
import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';
import { buildFundingPsbtInput } from '../psbtInputs';

bitcoin.initEccLib(ecc);

const network = bitcoin.networks.bitcoin;
const paymentKey = Buffer.from('0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798', 'hex');
const ordinalsKey = Buffer.from('c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709cb5', 'hex');

describe('buildFundingPsbtInput', () => {
  const baseUtxo = {
    txid: 'a'.repeat(64),
    vout: 0,
    value: 50_000,
  };

  it('builds native segwit input without redeemScript or tapInternalKey', () => {
    const paymentAddress = bitcoin.payments.p2wpkh({ pubkey: paymentKey, network }).address!;
    const input = buildFundingPsbtInput(
      { ...baseUtxo, address: paymentAddress },
      network,
      {
        ordinalsInternalPubkey: ordinalsKey,
        ordinalsAddress: bitcoin.payments.p2tr({ internalPubkey: ordinalsKey, network }).address!,
        paymentAddress,
        paymentPublicKey: paymentKey,
      },
    );
    const psbt = new bitcoin.Psbt({ network });
    psbt.addInput(input);
    const data = psbt.data.inputs[0];
    expect(data.redeemScript).toBeUndefined();
    expect(data.tapInternalKey).toBeUndefined();
  });

  it('builds P2SH nested segwit input with redeemScript', () => {
    const p2wpkh = bitcoin.payments.p2wpkh({ pubkey: paymentKey, network });
    const p2sh = bitcoin.payments.p2sh({ redeem: p2wpkh, network });
    const paymentAddress = p2sh.address!;
    const input = buildFundingPsbtInput(
      { ...baseUtxo, address: paymentAddress },
      network,
      {
        ordinalsInternalPubkey: ordinalsKey,
        ordinalsAddress: bitcoin.payments.p2tr({ internalPubkey: ordinalsKey, network }).address!,
        paymentAddress,
        paymentPublicKey: paymentKey,
      },
    );
    expect(input.redeemScript).toEqual(p2wpkh.output);
    expect(input.witnessUtxo?.script).toEqual(p2sh.output);
  });

  it('builds taproot input with tapInternalKey for ordinals address', () => {
    const ordinalsAddress = bitcoin.payments.p2tr({ internalPubkey: ordinalsKey, network }).address!;
    const input = buildFundingPsbtInput(
      { ...baseUtxo, address: ordinalsAddress },
      network,
      {
        ordinalsInternalPubkey: ordinalsKey,
        ordinalsAddress,
        paymentAddress: bitcoin.payments.p2wpkh({ pubkey: paymentKey, network }).address!,
        paymentPublicKey: paymentKey,
      },
    );
    expect(input.tapInternalKey).toEqual(ordinalsKey);
    expect(input.redeemScript).toBeUndefined();
  });

  it('rejects legacy P2PKH addresses with a clear message', () => {
    const legacy = bitcoin.payments.p2pkh({ pubkey: paymentKey, network }).address!;
    expect(() => buildFundingPsbtInput(
      { ...baseUtxo, address: legacy },
      network,
      {
        ordinalsInternalPubkey: ordinalsKey,
        ordinalsAddress: 'bc1pqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq',
        paymentAddress: legacy,
      },
    )).toThrow(/Legacy P2PKH/);
  });
});

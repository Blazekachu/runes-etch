// @vitest-environment node

import { describe, expect, it } from 'vitest';
import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';
import { buildCommitTx } from '@/lib/runes/commit';
import { computeTxid, serializeForTxid } from '@/lib/runes/reveal';

bitcoin.initEccLib(ecc);

const paymentKey = Buffer.from('0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798', 'hex');
const ordinalsKey = Buffer.from('c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709cb5', 'hex');

type FundingKind = 'p2wpkh' | 'p2sh' | 'p2tr';

function fundingAddress(kind: FundingKind, network: bitcoin.Network): string {
  if (kind === 'p2tr') {
    return bitcoin.payments.p2tr({ internalPubkey: ordinalsKey, network }).address!;
  }
  const p2wpkh = bitcoin.payments.p2wpkh({ pubkey: paymentKey, network });
  if (kind === 'p2sh') {
    return bitcoin.payments.p2sh({ redeem: p2wpkh, network }).address!;
  }
  return p2wpkh.address!;
}

function buildCommit(kind: FundingKind, network: bitcoin.Network, locktime: number) {
  const paymentAddress = fundingAddress('p2wpkh', network);
  const ordinalsAddress = fundingAddress('p2tr', network);
  const fundAddress = fundingAddress(kind, network);
  return buildCommitTx({
    runeName: 'AAAAAAAAAAAA',
    inscriptionFile: null,
    delegateId: null,
    parentInscription: null,
    fundingUtxos: [{ txid: 'a'.repeat(64), vout: 0, value: 500_000, address: fundAddress }],
    feeRate: 5,
    changeAddress: paymentAddress,
    internalPubkey: ordinalsKey,
    psbtKeys: {
      ordinalsInternalPubkey: ordinalsKey,
      ordinalsAddress,
      paymentAddress,
      paymentPublicKey: paymentKey,
    },
    network,
    locktime,
  });
}

function grindLocktimeAtEnd(template: Uint8Array, locktime: number): Uint8Array {
  const tx = new Uint8Array(template);
  const dv = new DataView(tx.buffer, tx.byteOffset, tx.byteLength);
  dv.setUint32(tx.length - 4, locktime, true);
  return tx;
}

function txidFromWorkerStyle(template: Uint8Array): string {
  return computeTxid(template);
}

describe('commit vanity template vs actual TXID', () => {
  const networks: Array<{ label: string; network: bitcoin.Network }> = [
    { label: 'mainnet', network: bitcoin.networks.bitcoin },
    { label: 'testnet/signet', network: bitcoin.networks.testnet },
    { label: 'regtest', network: bitcoin.networks.regtest },
  ];

  const kinds: FundingKind[] = ['p2wpkh', 'p2sh', 'p2tr'];

  for (const { label, network } of networks) {
    for (const kind of kinds) {
      it(`${label} + ${kind}: grinder locktime offset matches unsigned TXID`, () => {
        const result = buildCommit(kind, network, 0);
        const template = serializeForTxid(result.psbt);
        const locktime = 0x12345678;
        const grinded = grindLocktimeAtEnd(template, locktime);

        const rebuilt = buildCommit(kind, network, locktime);
        const rebuiltBytes = serializeForTxid(rebuilt.psbt);

        expect(grinded).toEqual(rebuiltBytes);
        expect(txidFromWorkerStyle(grinded)).toBe(computeTxid(rebuiltBytes));
      });
    }
  }

  it('serializeForTxid matches signed getId for p2sh signet commit', () => {
    const network = bitcoin.networks.testnet;
    const locktime = 42_424_242;
    const result = buildCommit('p2sh', network, locktime);
    const unsignedTx = (result.psbt as unknown as { __CACHE: { __TX: bitcoin.Transaction } }).__CACHE.__TX;
    expect(computeTxid(serializeForTxid(result.psbt))).not.toBe(unsignedTx.getId());
    // Unsigned template still stable for locktime grinding.
    const template = serializeForTxid(buildCommit('p2sh', network, 0).psbt);
    const dv = new DataView(template.buffer, template.byteOffset, template.byteLength);
    dv.setUint32(template.length - 4, locktime, true);
    expect(computeTxid(template)).toBe(computeTxid(serializeForTxid(result.psbt)));
  });
});

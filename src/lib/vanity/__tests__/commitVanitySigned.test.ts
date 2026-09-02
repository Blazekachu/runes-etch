// @vitest-environment node

import { describe, expect, it } from 'vitest';
import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';
import ECPairFactory from 'ecpair';
import { buildCommitTx, type CommitTxResult } from '@/lib/runes/commit';
import { computeTxid, serializeForTxid } from '@/lib/runes/reveal';

bitcoin.initEccLib(ecc);
const ECPair = ECPairFactory(ecc);

const keyPair = ECPair.fromPrivateKey(Buffer.from('0000000000000000000000000000000000000000000000000000000000000001', 'hex'));
const paymentKey = Buffer.from(keyPair.publicKey);
const ordinalsKey = Buffer.from('c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709cb5', 'hex');

type FundingKind = 'p2wpkh' | 'p2sh';

function buildCommit(kind: FundingKind, network: bitcoin.Network, locktime: number): CommitTxResult {
  const p2wpkh = bitcoin.payments.p2wpkh({ pubkey: paymentKey, network });
  const paymentAddress = kind === 'p2sh'
    ? bitcoin.payments.p2sh({ redeem: p2wpkh, network }).address!
    : p2wpkh.address!;
  const ordinalsAddress = bitcoin.payments.p2tr({ internalPubkey: ordinalsKey, network }).address!;

  return buildCommitTx({
    runeName: 'AAAAAAAAAAAA',
    inscriptionFile: null,
    delegateId: null,
    parentInscription: null,
    fundingUtxos: [{ txid: 'a'.repeat(64), vout: 0, value: 500_000, address: paymentAddress }],
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

function signCommit(built: CommitTxResult): bitcoin.Transaction {
  const psbt = built.psbt.clone();
  psbt.signInput(0, keyPair);
  psbt.finalizeAllInputs();
  return psbt.extractTransaction();
}

describe('signed commit TXID vs vanity grinder prediction', () => {
  const cases: Array<{ label: string; network: bitcoin.Network; kind: FundingKind }> = [
    { label: 'mainnet p2wpkh', network: bitcoin.networks.bitcoin, kind: 'p2wpkh' },
    { label: 'mainnet p2sh', network: bitcoin.networks.bitcoin, kind: 'p2sh' },
    { label: 'signet p2wpkh', network: bitcoin.networks.testnet, kind: 'p2wpkh' },
    { label: 'signet p2sh', network: bitcoin.networks.testnet, kind: 'p2sh' },
  ];

  for (const { label, network, kind } of cases) {
    it(`${label}: signed TXID matches grinder template at same locktime`, () => {
      const locktime = 0x00abcdef;
      const template = serializeForTxid(buildCommit(kind, network, 0).psbt);
      const dv = new DataView(template.buffer, template.byteOffset, template.byteLength);
      dv.setUint32(template.length - 4, locktime, true);
      const predicted = computeTxid(template);

      const built = buildCommit(kind, network, locktime);
      const unsignedTx = (built.psbt as unknown as { __CACHE: { __TX: bitcoin.Transaction } }).__CACHE.__TX;
      const tx = signCommit(built);

      expect(computeTxid(serializeForTxid(built.psbt))).toBe(predicted);
      expect(tx.getId()).toBe(predicted);
      if (kind === 'p2sh') {
        expect(unsignedTx.getId()).not.toBe(predicted);
      } else {
        expect(unsignedTx.getId()).toBe(predicted);
      }
    });
  }
});

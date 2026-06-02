import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the ord + mempool data layers so we control exactly what the indexer
// reports without touching the network.
vi.mock('@/lib/api/ordinals', () => ({
  getInscription: vi.fn(),
  getOutput: vi.fn(),
  isPublicOrdForCurrentNetwork: vi.fn(),
}));
vi.mock('@/lib/api/mempool', () => ({
  fetchUtxos: vi.fn(),
}));

import { resolveParentInscription } from '../resolveParent';
import { getInscription, getOutput, isPublicOrdForCurrentNetwork } from '@/lib/api/ordinals';
import { fetchUtxos } from '@/lib/api/mempool';

const USER = 'tb1p58h0wl2d74za6lesf8u9ews0z7cq604085dgj4uprx9tktmreznqp4dvtg';
const OTHER = 'tb1pgw439hxzr7vj0gzfqx69wl3plem4ne26kj7ktnuzj3lkpw5mmp3qhz7yv4';
const wallet = { taprootAddress: USER, paymentAddress: 'tb1qqg6r55examplepaymentaddrxxxxxxxxxxxxxx' };

// A parent that has MOVED: genesis output spent, now lives on a different UTXO.
const GENESIS = '7c16f5d1998b8eabb3f94fe8547a77c36d46c7d16fc8d766528d7bc6b31e38cc';
const CURRENT = 'ea1cf4c7586eb19171b5205c0827cc3fc905d5682267e84ebc2339ac9779c377';
const ID = `${GENESIS}i0`;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('resolveParentInscription — testnet with a local ord configured (#12)', () => {
  it('resolves to the CURRENT satpoint, never the genesis outpoint', async () => {
    (isPublicOrdForCurrentNetwork as ReturnType<typeof vi.fn>).mockReturnValue(false); // local ord present
    (getInscription as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: ID, address: USER, satpoint: `${CURRENT}:0:0`, sat: 102955508042499,
    });
    (getOutput as ReturnType<typeof vi.fn>).mockResolvedValue({
      address: USER, inscriptions: [ID], runes: {}, value: 9889,
    });

    const res = await resolveParentInscription(ID, wallet);

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.parent.txid).toBe(CURRENT); // the live UTXO — NOT the spent genesis
      expect(res.parent.vout).toBe(0);
      expect(res.parent.value).toBe(9889);
      expect(res.parent.address).toBe(USER);
      expect(res.owned).toBe(true);
    }
    expect(fetchUtxos).not.toHaveBeenCalled(); // genesis-guess path must not run
  });

  it('reports owned=false when the parent now lives on another address', async () => {
    (isPublicOrdForCurrentNetwork as ReturnType<typeof vi.fn>).mockReturnValue(false);
    (getInscription as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: ID, address: OTHER, satpoint: `${CURRENT}:0:0`, sat: 1,
    });
    (getOutput as ReturnType<typeof vi.fn>).mockResolvedValue({
      address: OTHER, inscriptions: [ID], runes: {}, value: 9889,
    });

    const res = await resolveParentInscription(ID, wallet);

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.parent.address).toBe(OTHER);
      expect(res.owned).toBe(false); // must NOT falsely claim ownership
    }
  });

  it('falls back to the genesis guess ONLY when no local ord is configured (public ordinals.com)', async () => {
    (isPublicOrdForCurrentNetwork as ReturnType<typeof vi.fn>).mockReturnValue(true); // mainnet-only public indexer
    (fetchUtxos as ReturnType<typeof vi.fn>).mockResolvedValue([{ txid: GENESIS, vout: 0, value: 600 }]);

    const res = await resolveParentInscription(ID, wallet);

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.parent.txid).toBe(GENESIS); // degraded path: best-effort genesis outpoint
      expect(res.parent.value).toBe(600);
    }
    expect(getInscription).not.toHaveBeenCalled(); // can't query a testnet id against mainnet ord
  });
});

describe('resolveParentInscription — mainnet (#12, unchanged behavior via ord)', () => {
  const mainWallet = {
    taprootAddress: 'bc1pmainnettaprootxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    paymentAddress: 'bc1qmainnetpaymentxxxxxxxxxxxxxxxxxxxxxxxx',
  };
  const mainId = `${'a'.repeat(64)}i0`;

  it('resolves via ord and checks real ownership', async () => {
    (isPublicOrdForCurrentNetwork as ReturnType<typeof vi.fn>).mockReturnValue(true); // mainnet public ord is usable
    (getInscription as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: mainId, address: mainWallet.taprootAddress, satpoint: `${'b'.repeat(64)}:1:0`, sat: 5,
    });
    (getOutput as ReturnType<typeof vi.fn>).mockResolvedValue({
      address: mainWallet.taprootAddress, inscriptions: [mainId], runes: {}, value: 10000,
    });

    const res = await resolveParentInscription(mainId, mainWallet);

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.parent.txid).toBe('b'.repeat(64));
      expect(res.parent.vout).toBe(1);
      expect(res.owned).toBe(true);
    }
  });
});

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { getRuneNameStatus, checkRuneNameAvailable, getRuneMinimumFromOrd, setOrdinalsTestnet } from '../ordinals';

/**
 * Tests for Finding #10 — ord 404 must not silently mean "name is available"
 * when the indexer is behind chain tip. `getRuneNameStatus` must return
 * 'unknown' with lag context in that case.
 *
 * Setup: mock global.fetch so we can stage independent responses for
 *  - GET .../rune/<name>          (the lookup)
 *  - GET .../status               (ord indexer height)
 *  - GET .../blocks/tip/height    (mempool chain tip)
 */

type MockResponses = {
  rune?: { status: number; body?: unknown };
  ordStatus?: { status: number; body?: unknown } | 'reject';
  chainTip?: { status: number; body?: string } | 'reject';
};

function installFetchMock(r: MockResponses) {
  global.fetch = vi.fn(async (url: string | URL) => {
    const u = url.toString();
    if (u.includes('/rune/')) {
      const cfg = r.rune ?? { status: 404 };
      return new Response(cfg.body ? JSON.stringify(cfg.body) : 'not found', { status: cfg.status });
    }
    if (u.endsWith('/status')) {
      if (r.ordStatus === 'reject') throw new Error('ord status unreachable');
      const cfg = r.ordStatus ?? { status: 200, body: { height: 850000 } };
      return new Response(JSON.stringify(cfg.body ?? {}), { status: cfg.status });
    }
    if (u.includes('/blocks/tip/height')) {
      if (r.chainTip === 'reject') throw new Error('mempool unreachable');
      const cfg = r.chainTip ?? { status: 200, body: '850000' };
      return new Response(cfg.body ?? '0', { status: cfg.status });
    }
    throw new Error(`Unmocked fetch: ${u}`);
  }) as unknown as typeof fetch;
}

describe('getRuneNameStatus (Finding #10 — lag-aware rune lookup)', () => {
  beforeEach(() => {
    // Force mainnet path so the testnet-public-ord short-circuit doesn't apply.
    setOrdinalsTestnet('bc1qxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx');
  });

  it('returns "taken" when ord returns 200 with rune data', async () => {
    installFetchMock({
      rune: { status: 200, body: { entry: { spaced_rune: 'BUDDY', number: 1 } } },
    });
    const s = await getRuneNameStatus('BUDDY');
    expect(s.state).toBe('taken');
  });

  it('returns "available" when ord 404s AND indexer is at chain tip', async () => {
    installFetchMock({
      rune: { status: 404 },
      ordStatus: { status: 200, body: { height: 850000 } },
      chainTip: { status: 200, body: '850000' },
    });
    const s = await getRuneNameStatus('NEVERETCHED');
    expect(s.state).toBe('available');
  });

  it('returns "available" when indexer is within the lag threshold (<=3 blocks)', async () => {
    installFetchMock({
      rune: { status: 404 },
      ordStatus: { status: 200, body: { height: 849997 } },
      chainTip: { status: 200, body: '850000' },
    });
    const s = await getRuneNameStatus('NEVERETCHED');
    expect(s.state).toBe('available');
  });

  it('returns "unknown" when ord 404s AND indexer is >3 blocks behind chain tip', async () => {
    installFetchMock({
      rune: { status: 404 },
      ordStatus: { status: 200, body: { height: 849990 } },
      chainTip: { status: 200, body: '850000' },
    });
    const s = await getRuneNameStatus('NEVERETCHED');
    expect(s.state).toBe('unknown');
    if (s.state === 'unknown') {
      expect(s.behind).toBe(10);
      expect(s.indexerHeight).toBe(849990);
      expect(s.chainHeight).toBe(850000);
      expect(s.reason).toBe('indexer-lagging');
    }
  });

  it('returns "unknown" matching BUDDY scenario (44 blocks behind)', async () => {
    installFetchMock({
      rune: { status: 404 },
      ordStatus: { status: 200, body: { height: 136478 } },
      chainTip: { status: 200, body: '136522' },
    });
    const s = await getRuneNameStatus('BUDDY');
    expect(s.state).toBe('unknown');
    if (s.state === 'unknown') expect(s.behind).toBe(44);
  });

  it('falls back to "available" when mempool tip fetch fails (degraded)', async () => {
    installFetchMock({
      rune: { status: 404 },
      ordStatus: { status: 200, body: { height: 850000 } },
      chainTip: 'reject',
    });
    const s = await getRuneNameStatus('NEVERETCHED');
    expect(s.state).toBe('available');
  });

  it('falls back to "available" when ord status fetch fails (degraded)', async () => {
    installFetchMock({
      rune: { status: 404 },
      ordStatus: 'reject',
      chainTip: { status: 200, body: '850000' },
    });
    const s = await getRuneNameStatus('NEVERETCHED');
    expect(s.state).toBe('available');
  });

  it('throws on non-404 non-2xx errors from ord', async () => {
    installFetchMock({ rune: { status: 500 } });
    await expect(getRuneNameStatus('FOO')).rejects.toThrow(/500/);
  });

  it('throws on invalid rune name format', async () => {
    await expect(getRuneNameStatus('lowercase')).rejects.toThrow(/Invalid rune name/);
  });
});

describe('checkRuneNameAvailable (backwards-compat wrapper)', () => {
  beforeEach(() => {
    setOrdinalsTestnet('bc1qxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx');
  });

  it('returns true when status is "available"', async () => {
    installFetchMock({
      rune: { status: 404 },
      ordStatus: { status: 200, body: { height: 850000 } },
      chainTip: { status: 200, body: '850000' },
    });
    expect(await checkRuneNameAvailable('NEVERETCHED')).toBe(true);
  });

  it('returns false when status is "taken"', async () => {
    installFetchMock({
      rune: { status: 200, body: { entry: { spaced_rune: 'BUDDY' } } },
    });
    expect(await checkRuneNameAvailable('BUDDY')).toBe(false);
  });

  it('returns false (fail-safe) when status is "unknown" — never claim available on lag', async () => {
    installFetchMock({
      rune: { status: 404 },
      ordStatus: { status: 200, body: { height: 850000 - 50 } },
      chainTip: { status: 200, body: '850000' },
    });
    expect(await checkRuneNameAvailable('NEVERETCHED')).toBe(false);
  });
});

describe('getRuneMinimumFromOrd (Finding #11)', () => {
  beforeEach(() => {
    setOrdinalsTestnet('bc1qxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx');
  });

  function installStatusMock(minName: string | undefined, status = 200) {
    global.fetch = vi.fn(async (url: string | URL) => {
      const u = url.toString();
      if (u.endsWith('/status')) {
        return new Response(JSON.stringify({ minimum_rune_for_next_block: minName }), { status });
      }
      throw new Error(`Unmocked fetch: ${u}`);
    }) as unknown as typeof fetch;
  }

  it('returns the u128 value of ord-reported minimum name', async () => {
    installStatusMock('FBQUW'); // testnet4 observed minimum in BUDDY incident
    const min = await getRuneMinimumFromOrd();
    // F=6,B=2,Q=17,U=21,W=23 → bijective base-26: ((((6*26+2)*26+17)*26+21)*26+23) − 1 = 2,789,068
    expect(min).toBe(2_789_068n);
  });

  it('returns 0 (single-letter "A") for the all-unlocked state', async () => {
    installStatusMock('A');
    expect(await getRuneMinimumFromOrd()).toBe(0n);
  });

  it('returns null on HTTP 5xx', async () => {
    installStatusMock('FBQUW', 500);
    expect(await getRuneMinimumFromOrd()).toBeNull();
  });

  it('returns null when minimum_rune_for_next_block is missing', async () => {
    installStatusMock(undefined);
    expect(await getRuneMinimumFromOrd()).toBeNull();
  });

  it('returns null on malformed rune name (lowercase / non-letter)', async () => {
    installStatusMock('fbquw');
    expect(await getRuneMinimumFromOrd()).toBeNull();
  });

  it('returns null on fetch failure (network/timeout/abort)', async () => {
    global.fetch = vi.fn(async () => { throw new Error('network down'); }) as unknown as typeof fetch;
    expect(await getRuneMinimumFromOrd()).toBeNull();
  });
});

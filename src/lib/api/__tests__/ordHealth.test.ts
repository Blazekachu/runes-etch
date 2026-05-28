import { describe, it, expect, beforeEach, vi } from 'vitest';
import { getOrdHealth } from '../ordHealth';
import { setOrdinalsTestnet } from '../ordinals';

type MockResponses = {
  ordStatus?: { status: number; body?: unknown } | 'reject';
  chainTip?: { status: number; body?: string } | 'reject';
};

function installFetchMock(r: MockResponses) {
  global.fetch = vi.fn(async (url: string | URL) => {
    const u = url.toString();
    if (u.endsWith('/status')) {
      if (r.ordStatus === 'reject') throw new Error('ord status unreachable');
      const cfg = r.ordStatus ?? { status: 200, body: { height: 850000, unrecoverably_reorged: false } };
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

describe('getOrdHealth (#0b — wedged-ord detection)', () => {
  beforeEach(() => {
    // Force mainnet path so the public-ord short-circuit doesn't apply.
    setOrdinalsTestnet('bc1qxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx');
  });

  it('returns "healthy" when ord is at chain tip and not reorged', async () => {
    installFetchMock({
      ordStatus: { status: 200, body: { height: 850000, unrecoverably_reorged: false } },
      chainTip: { status: 200, body: '850000' },
    });
    const h = await getOrdHealth();
    expect(h.state).toBe('healthy');
    if (h.state === 'healthy') {
      expect(h.indexerHeight).toBe(850000);
      expect(h.chainHeight).toBe(850000);
    }
  });

  it('returns "lagging" when ord is more than 3 blocks behind but not reorged', async () => {
    installFetchMock({
      ordStatus: { status: 200, body: { height: 849990, unrecoverably_reorged: false } },
      chainTip: { status: 200, body: '850000' },
    });
    const h = await getOrdHealth();
    expect(h.state).toBe('lagging');
    if (h.state === 'lagging') {
      expect(h.behind).toBe(10);
      expect(h.indexerHeight).toBe(849990);
      expect(h.chainHeight).toBe(850000);
    }
  });

  it('returns "wedged" when unrecoverably_reorged is true (even if behind is small)', async () => {
    installFetchMock({
      ordStatus: { status: 200, body: { height: 136721, unrecoverably_reorged: true } },
      chainTip: { status: 200, body: '136737' },
    });
    const h = await getOrdHealth();
    expect(h.state).toBe('wedged');
    if (h.state === 'wedged') {
      expect(h.behind).toBe(16);
      expect(h.indexerHeight).toBe(136721);
      expect(h.chainHeight).toBe(136737);
    }
  });

  it('returns "wedged" even when ord is at tip but unrecoverably_reorged is true', async () => {
    installFetchMock({
      ordStatus: { status: 200, body: { height: 850000, unrecoverably_reorged: true } },
      chainTip: { status: 200, body: '850000' },
    });
    const h = await getOrdHealth();
    expect(h.state).toBe('wedged');
  });

  it('returns "unreachable" when ord /status throws', async () => {
    installFetchMock({
      ordStatus: 'reject',
      chainTip: { status: 200, body: '850000' },
    });
    const h = await getOrdHealth();
    expect(h.state).toBe('unreachable');
  });

  it('returns "unreachable" when ord /status 5xx', async () => {
    installFetchMock({
      ordStatus: { status: 503 },
      chainTip: { status: 200, body: '850000' },
    });
    const h = await getOrdHealth();
    expect(h.state).toBe('unreachable');
  });

  it('returns "unreachable" when mempool chain tip throws (cannot measure lag)', async () => {
    installFetchMock({
      ordStatus: { status: 200, body: { height: 850000, unrecoverably_reorged: false } },
      chainTip: 'reject',
    });
    const h = await getOrdHealth();
    expect(h.state).toBe('unreachable');
  });

  it('returns "skipped" on testnet with public ord (mainnet-only indexer)', async () => {
    setOrdinalsTestnet('tb1qxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx');
    // No mock installed — call should short-circuit before any fetch.
    global.fetch = vi.fn(async () => {
      throw new Error('fetch should not be called when skipped');
    }) as unknown as typeof fetch;
    const h = await getOrdHealth();
    expect(h.state).toBe('skipped');
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setMempoolNetwork, getCurrentBlockHeight, fetchUtxos, _resetMempoolProvidersForTests } from '../mempool';

// realistic-length signet taproot addresses (validateAddress requires 26-90 chars)
const TADDR = 'tb1p58h0wl2d74za6lesf8u9ews0z7cq604085dgj4uprx9tktmreznqp4dvtg';
const HOARDER = 'tb1pq6r556kx3rdg9jv4gu680averf53y6p8ue5phqqg6r556kx3rdg9jv4gu';

describe('mempool provider fallback (#5)', () => {
  beforeEach(() => {
    _resetMempoolProvidersForTests();
  });

  it('prefers emzy first when both providers are up', async () => {
    const calls: string[] = [];
    global.fetch = vi.fn(async (url: string | URL) => {
      const u = url.toString();
      calls.push(u);
      if (u === 'https://mempool.emzy.de/signet/api/blocks/tip/height') {
        return new Response('137015', { status: 200 });
      }
      if (u.startsWith('https://mempool.space/')) {
        return new Response('999999', { status: 200 });
      }
      throw new Error('unmocked: ' + u);
    }) as unknown as typeof fetch;

    await setMempoolNetwork('signet');
    const h = await getCurrentBlockHeight();
    expect(h).toBe(137015);
    expect(calls[0]).toContain('mempool.emzy.de');
    expect(calls.some((c) => c.includes('mempool.space'))).toBe(false);
  });

  it('falls back when emzy is unreachable (space still works)', async () => {
    global.fetch = vi.fn(async (url: string | URL) => {
      const u = url.toString();
      if (u.startsWith('https://mempool.emzy.de/')) throw new Error('emzy timeout');
      if (u === 'https://mempool.space/signet/api/blocks/tip/height') {
        return new Response('137015', { status: 200 });
      }
      throw new Error('unmocked: ' + u);
    }) as unknown as typeof fetch;

    await setMempoolNetwork('signet');
    const h = await getCurrentBlockHeight();
    expect(h).toBe(137015);
  });

  it('keeps sticky preferred provider across setMempoolNetwork(same chain)', async () => {
    const calls: string[] = [];
    global.fetch = vi.fn(async (url: string | URL) => {
      const u = url.toString();
      calls.push(u);
      if (u.startsWith('https://mempool.emzy.de/')) throw new Error('emzy timeout');
      if (u === 'https://mempool.space/signet/api/blocks/tip/height') {
        return new Response('137015', { status: 200 });
      }
      throw new Error('unmocked: ' + u);
    }) as unknown as typeof fetch;

    await setMempoolNetwork('signet');
    await getCurrentBlockHeight(); // fails over to space, sticky = space
    calls.length = 0;
    await setMempoolNetwork('signet'); // must NOT wipe sticky preferred
    await getCurrentBlockHeight();
    expect(calls[0]).toContain('mempool.space');
    expect(calls.some((c) => c.includes('emzy'))).toBe(false);
  });

  it('does NOT fall back on a 4xx (preserves hoarder-address 400 -> /txs walk)', async () => {
    // primary (emzy) returns 400 on /utxo (too many utxos). Must NOT switch providers;
    // fetchUtxos handles 400 by walking /txs/chain on the SAME provider.
    const calls: string[] = [];
    global.fetch = vi.fn(async (url: string | URL) => {
      const u = url.toString();
      calls.push(u);
      if (u.includes('mempool.emzy.de/signet/api/address/') && u.endsWith('/utxo')) {
        return new Response('', { status: 400 });
      }
      if (u.includes('mempool.emzy.de/signet/api/address/') && u.includes('/txs/chain')) {
        return new Response('[]', { status: 200 }); // empty walk -> no utxos
      }
      if (u.includes('mempool.emzy.de/signet/api/address/') && u.endsWith('/txs/mempool')) {
        return new Response('[]', { status: 200 });
      }
      throw new Error('unmocked: ' + u);
    }) as unknown as typeof fetch;

    await setMempoolNetwork('signet');
    const utxos = await fetchUtxos(HOARDER);
    expect(utxos).toEqual([]);
    // the 400 must have triggered the /txs walk on emzy, NOT a hop to space
    expect(calls.some((c) => c.includes('mempool.emzy.de') && c.includes('/txs/chain'))).toBe(true);
    expect(calls.some((c) => c.includes('mempool.space'))).toBe(false);
  });

  it('falls back on provider rate-limit 429', async () => {
    const calls: string[] = [];
    global.fetch = vi.fn(async (url: string | URL) => {
      const u = url.toString();
      calls.push(u);
      if (u.includes('mempool.emzy.de/signet/api/address/') && u.endsWith('/utxo')) {
        return new Response('rate limited', { status: 429 });
      }
      if (u.includes('memepool.space/signet/api/address/') && u.endsWith('/utxo')) {
        return new Response('[]', { status: 200 });
      }
      if (u.includes('mempool.space/signet/api/address/') && u.endsWith('/utxo')) {
        return new Response('[]', { status: 200 });
      }
      throw new Error('unmocked: ' + u);
    }) as unknown as typeof fetch;

    await setMempoolNetwork('signet');
    const utxos = await fetchUtxos(TADDR);
    expect(utxos).toEqual([]);
    expect(calls.some((c) => c.includes('mempool.emzy.de') && c.endsWith('/utxo'))).toBe(true);
    expect(calls.some((c) => c.includes('memepool.space') && c.endsWith('/utxo'))).toBe(true);
  });

  it('mainnet also falls back to memepool.space on 429', async () => {
    const calls: string[] = [];
    const mainAddr = 'bc1pt6e3x6k9h4xys6wmw9q0df2f6z9m6m8qf3r7p2mjj4jvs2w8wwgq9f0t5y';
    global.fetch = vi.fn(async (url: string | URL) => {
      const u = url.toString();
      calls.push(u);
      if (u.includes('mempool.emzy.de/api/address/') && u.endsWith('/utxo')) {
        return new Response('rate limited', { status: 429 });
      }
      if (u.includes('memepool.space/api/address/') && u.endsWith('/utxo')) {
        return new Response('[]', { status: 200 });
      }
      if (u.includes('mempool.space/api/address/') && u.endsWith('/utxo')) {
        return new Response('[]', { status: 200 });
      }
      throw new Error('unmocked: ' + u);
    }) as unknown as typeof fetch;

    await setMempoolNetwork('mainnet');
    const utxos = await fetchUtxos(mainAddr);
    expect(utxos).toEqual([]);
    expect(calls.some((c) => c.includes('mempool.emzy.de/api/address/') && c.endsWith('/utxo'))).toBe(true);
    expect(calls.some((c) => c.includes('memepool.space/api/address/') && c.endsWith('/utxo'))).toBe(true);
  });
});

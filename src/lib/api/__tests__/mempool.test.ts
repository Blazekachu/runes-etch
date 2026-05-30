import { describe, it, expect, vi } from 'vitest';
import { setMempoolNetwork, getCurrentBlockHeight, fetchUtxos } from '../mempool';

// realistic-length testnet4 taproot addresses (validateAddress requires 26-90 chars)
const TADDR = 'tb1p58h0wl2d74za6lesf8u9ews0z7cq604085dgj4uprx9tktmreznqp4dvtg';
const HOARDER = 'tb1pq6r556kx3rdg9jv4gu680averf53y6p8ue5phqqg6r556kx3rdg9jv4gu';

describe('mempool provider fallback (#5)', () => {
  it('falls back to mempool.emzy.de (testnet4) when mempool.space is unreachable', async () => {
    // mempool.space is down (every request throws); emzy serves testnet4.
    global.fetch = vi.fn(async (url: string | URL) => {
      const u = url.toString();
      if (u.startsWith('https://mempool.space/')) throw new Error('mempool.space timeout');
      if (u.includes('mempool.emzy.de/testnet4/api/address/') && u.endsWith('/utxo')) {
        return new Response('[]', { status: 200 });
      }
      if (u === 'https://mempool.emzy.de/testnet4/api/blocks/tip/height') {
        return new Response('137015', { status: 200 });
      }
      throw new Error('unmocked: ' + u);
    }) as unknown as typeof fetch;

    await setMempoolNetwork(TADDR); // testnet4; primary probe must fall through to emzy
    const h = await getCurrentBlockHeight();
    expect(h).toBe(137015);
  });

  it('does NOT fall back on a 4xx (preserves hoarder-address 400 -> /txs walk)', async () => {
    // primary returns 400 on /utxo (too many utxos). Must NOT switch providers;
    // fetchUtxos handles 400 by walking /txs/chain on the SAME provider.
    const calls: string[] = [];
    global.fetch = vi.fn(async (url: string | URL) => {
      const u = url.toString();
      calls.push(u);
      if (u.includes('mempool.space/testnet4/api/address/') && u.endsWith('/utxo')) {
        return new Response('', { status: 400 });
      }
      if (u.includes('mempool.space/testnet4/api/address/') && u.includes('/txs/chain')) {
        return new Response('[]', { status: 200 }); // empty walk -> no utxos
      }
      if (u.includes('mempool.space/testnet4/api/address/') && u.endsWith('/txs/mempool')) {
        return new Response('[]', { status: 200 });
      }
      throw new Error('unmocked: ' + u);
    }) as unknown as typeof fetch;

    await setMempoolNetwork(HOARDER); // probe utxo 400 -> still testnet4
    const utxos = await fetchUtxos(HOARDER);
    expect(utxos).toEqual([]);
    // the 400 must have triggered the /txs walk on mempool.space, NOT a hop to emzy
    expect(calls.some((c) => c.includes('mempool.space') && c.includes('/txs/chain'))).toBe(true);
    expect(calls.some((c) => c.includes('emzy'))).toBe(false);
  });
});

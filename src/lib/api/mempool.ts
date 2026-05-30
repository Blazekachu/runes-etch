import * as bitcoin from 'bitcoinjs-lib';
import type { FeeRates, Utxo } from '@/types';

/** Returns the bitcoinjs-lib network object for the given address */
export function bitcoinNetworkForAddress(address?: string): bitcoin.Network {
  if (address && (address.startsWith('tb1') || address.startsWith('2') || address.startsWith('m') || address.startsWith('n'))) {
    return bitcoin.networks.testnet;
  }
  return bitcoin.networks.bitcoin;
}

const MEMPOOL_MAINNET = 'https://mempool.space/api';
const MEMPOOL_TESTNET4 = 'https://mempool.space/testnet4/api';
const MEMPOOL_TESTNET3 = 'https://mempool.space/testnet/api';

// Fallback providers (Punch List #5). All speak the mempool.space Esplora API,
// so they're drop-in. mempool.space is primary; mempool.emzy.de is a community
// mirror that ALSO serves testnet4 — the only public testnet4 fallback
// (blockstream.info has no testnet4). When the primary is unreachable or 5xx,
// calls transparently fail over to the next provider, and the working one is
// remembered for the session so a downed primary isn't re-tried on every call.
const EMZY_MAINNET = 'https://mempool.emzy.de/api';
const EMZY_TESTNET4 = 'https://mempool.emzy.de/testnet4/api';
const EMZY_TESTNET3 = 'https://mempool.emzy.de/testnet/api';

const PROVIDERS: Record<'mainnet' | 'testnet4' | 'testnet3', string[]> = {
  mainnet: [MEMPOOL_MAINNET, EMZY_MAINNET],
  testnet4: [MEMPOOL_TESTNET4, EMZY_TESTNET4],
  testnet3: [MEMPOOL_TESTNET3, EMZY_TESTNET3],
};

function isTestnetAddress(address?: string): boolean {
  return !!address && (address.startsWith('tb1') || address.startsWith('2') || address.startsWith('m') || address.startsWith('n'));
}

/** Detect network from address prefix and return the primary API base.
 *  (Kept for direct/display use; live fetches go through the fallback list.) */
export function mempoolBaseForAddress(address?: string): string {
  return isTestnetAddress(address) ? MEMPOOL_TESTNET4 : MEMPOOL_MAINNET;
}

// Ordered provider list for the current session, set by setMempoolNetwork().
let activeBases: string[] = PROVIDERS.mainnet;
// Index (into the active list) of the last provider that worked — tried first.
let preferredProviderIdx = 0;

/** Try each base (starting from the last-good one) until one returns without a
 *  network error or 5xx. 4xx responses are returned as-is — callers like
 *  fetchUtxos depend on seeing a 400 (too-many-utxos -> /txs walk), and a 4xx is
 *  a real answer, not a provider outage. Remembers the working provider. */
async function tryProviders(bases: string[], path: string, init?: RequestInit, timeoutMs = FETCH_TIMEOUT_MS): Promise<Response> {
  const list = bases.length ? bases : [MEMPOOL_MAINNET];
  let lastErr: unknown;
  for (let i = 0; i < list.length; i++) {
    const idx = (preferredProviderIdx + i) % list.length;
    try {
      const res = await fetchWithTimeout(`${list[idx]}${path}`, init, timeoutMs);
      if (res.status >= 500 && i < list.length - 1) { lastErr = new Error(`${list[idx]} -> ${res.status}`); continue; }
      preferredProviderIdx = idx;
      return res;
    } catch (err) {
      lastErr = err; // network error / timeout -> try next provider
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('All mempool providers unreachable');
}

/** Fetch a path against the active network's provider list, with fallback. */
function mempoolFetch(path: string, init?: RequestInit, timeoutMs?: number): Promise<Response> {
  return tryProviders(activeBases, path, init, timeoutMs);
}

/** Call once at wallet connect to set the API provider list for the session.
 *  Testnet addresses default to testnet4 (our chain); only if testnet4 is
 *  unreachable across ALL providers do we fall back to testnet3. */
export async function setMempoolNetwork(address: string): Promise<void> {
  preferredProviderIdx = 0;
  if (isTestnetAddress(address)) {
    activeBases = PROVIDERS.testnet4;
    try {
      const res = await mempoolFetch(`/address/${encodeURIComponent(address)}/utxo`, undefined, 5000);
      // 2xx or 400 (too-many-utxos) both confirm testnet4 is the right network.
      if (res.ok || res.status === 400) return;
    } catch { /* all testnet4 providers unreachable */ }
    activeBases = PROVIDERS.testnet3;
    return;
  }
  activeBases = PROVIDERS.mainnet;
}

const FETCH_TIMEOUT_MS = 15000;

// L7: All fetches use a timeout to prevent hanging on unresponsive APIs.
// The abort reason is non-empty so AbortError surfaces as a human-meaningful
// message instead of "signal is aborted without reason".
function fetchWithTimeout(url: string, init?: RequestInit, timeoutMs = FETCH_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error(`Request timed out after ${timeoutMs}ms: ${url}`)),
    timeoutMs,
  );
  return fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
}

/** Retry a function once if it throws an AbortError (likely a timeout under mempool load). */
async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const isAbort = err instanceof Error && (err.name === 'AbortError' || /aborted|timed out/i.test(err.message));
    if (!isAbort) throw err;
    return await fn();
  }
}

const TXID_RE = /^[0-9a-f]{64}$/i;
const ADDRESS_RE = /^[a-zA-Z0-9]{26,90}$/;
const TX_HEX_RE = /^[0-9a-f]+$/i;

function validateTxid(txid: string): void {
  if (!TXID_RE.test(txid)) throw new Error(`Invalid txid: ${txid}`);
}

function validateAddress(address: string): void {
  if (!ADDRESS_RE.test(address)) throw new Error(`Invalid address format: ${address}`);
}

export async function fetchFeeRates(): Promise<FeeRates> {
  // 30s + 1 retry: fee endpoint is tiny but mempool.space queues under heavy
  // concurrent load (e.g. while a parallel /utxo or /txs walk is hammering it),
  // and the default 15s would abort under those conditions.
  const res = await withRetry(() =>
    mempoolFetch('/v1/fees/recommended', undefined, 30_000)
  );
  if (!res.ok) throw new Error(`Failed to fetch fee rates: ${res.status}`);
  const data = await res.json();
  // M1: Validate fee rate response — don't trust blindly
  for (const key of ['fastestFee', 'halfHourFee', 'hourFee', 'economyFee', 'minimumFee']) {
    const v = data[key];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 1 || v > 10000) {
      throw new Error(`Invalid fee rate from API: ${key}=${v}`);
    }
  }
  // M1b: Sanity check — flag if fastest fee is anomalously high (>500 sat/vB)
  if (data.fastestFee > 500) {
    data._feeWarning = `Unusually high fee environment: ${data.fastestFee} sat/vB. Verify before proceeding.`;
  }
  return data;
}

export async function fetchUtxos(address: string): Promise<Utxo[]> {
  validateAddress(address);
  const res = await mempoolFetch(`/address/${encodeURIComponent(address)}/utxo`);
  // mempool.space (esplora) /utxo returns 400 on addresses with too many UTXOs
  // (undocumented cap, ~500). Fall back to walking /txs and deriving UTXOs
  // client-side. Other failures propagate normally.
  if (res.status === 400) return fetchUtxosByTxWalk(address);
  if (!res.ok) throw new Error(`Failed to fetch UTXOs: ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data)) throw new Error('Invalid UTXO response: expected array');
  for (const u of data) {
    if (typeof u.txid !== 'string' || !TXID_RE.test(u.txid)) throw new Error(`Invalid UTXO txid: ${u.txid}`);
    if (typeof u.vout !== 'number' || !Number.isInteger(u.vout) || u.vout < 0) throw new Error(`Invalid UTXO vout: ${u.vout}`);
    if (typeof u.value !== 'number' || !Number.isFinite(u.value) || u.value < 0) throw new Error(`Invalid UTXO value: ${u.value}`);
  }
  return data;
}

/**
 * Esplora TX shape (subset we use). Both mempool.space and blockstream return
 * the same structure here.
 */
interface EsploraTx {
  txid: string;
  status: { confirmed: boolean; block_height?: number };
  vin: Array<{ txid: string; vout: number; prevout?: { scriptpubkey_address?: string } }>;
  vout: Array<{ scriptpubkey_address?: string; value: number }>;
}

/**
 * Page through /txs/chain (25 per page) + /txs/mempool, then derive UTXOs
 * client-side: collect all vouts paying `address`, then remove those whose
 * outpoints appear as vins in any of those same txs.
 *
 * Slow for big addresses (one HTTP request per 25 confirmed txs) but it's
 * the only resilient path for hoarder addresses where /utxo 400s. Each
 * page gets a longer timeout + one retry — mempool.space's electrs can
 * take >15s under load and the default fetch timeout would abort otherwise.
 * Caller sees the loading spinner the whole time.
 */
const WALK_TIMEOUT_MS = 45_000;

async function walkFetch(path: string): Promise<Response> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await mempoolFetch(path, undefined, WALK_TIMEOUT_MS);
    } catch (err) {
      if (attempt === 1) throw err;
    }
  }
  throw new Error('unreachable');
}

async function fetchUtxosByTxWalk(address: string): Promise<Utxo[]> {
  const txs: EsploraTx[] = [];

  // Confirmed txs, paginated by last-seen txid.
  let lastSeen: string | undefined;
  for (let page = 0; page < 400; page++) {  // hard cap: 400 pages = 10,000 txs
    const path = lastSeen
      ? `/address/${encodeURIComponent(address)}/txs/chain/${lastSeen}`
      : `/address/${encodeURIComponent(address)}/txs/chain`;
    const res = await walkFetch(path);
    if (!res.ok) throw new Error(`Failed to walk address txs: ${res.status}`);
    const batch: EsploraTx[] = await res.json();
    if (!Array.isArray(batch) || batch.length === 0) break;
    txs.push(...batch);
    if (batch.length < 25) break;  // final page
    lastSeen = batch[batch.length - 1].txid;
  }

  // Unconfirmed txs (single non-paginated batch, up to 50).
  try {
    const memRes = await walkFetch(`/address/${encodeURIComponent(address)}/txs/mempool`);
    if (memRes.ok) {
      const memBatch: EsploraTx[] = await memRes.json();
      if (Array.isArray(memBatch)) txs.push(...memBatch);
    }
  } catch { /* unconfirmed pool is best-effort */ }

  // Derive UTXOs: outputs paying `address`, minus those spent by any vin we saw.
  const utxos = new Map<string, Utxo>();
  for (const tx of txs) {
    for (let i = 0; i < tx.vout.length; i++) {
      const o = tx.vout[i];
      if (o.scriptpubkey_address === address && Number.isFinite(o.value) && o.value >= 0) {
        utxos.set(`${tx.txid}:${i}`, {
          txid: tx.txid,
          vout: i,
          value: o.value,
          status: tx.status,
        });
      }
    }
  }
  for (const tx of txs) {
    for (const v of tx.vin) {
      if (v.prevout?.scriptpubkey_address === address) {
        utxos.delete(`${v.txid}:${v.vout}`);
      }
    }
  }
  return Array.from(utxos.values());
}

export async function broadcastTx(txHex: string): Promise<string> {
  if (!TX_HEX_RE.test(txHex)) throw new Error('Invalid transaction hex');
  const res = await mempoolFetch('/tx', {
    method: 'POST',
    body: txHex,
  });
  if (!res.ok) {
    const errorText = await res.text();
    // L6: Truncate and sanitize raw node error before it reaches UI
    const safeError = errorText.replace(/[<>&"']/g, '').slice(0, 200);
    throw new Error(`Broadcast failed: ${safeError}`);
  }
  return res.text();
}

export async function getTxStatus(txid: string): Promise<{
  confirmed: boolean;
  block_height?: number;
}> {
  validateTxid(txid);
  const res = await mempoolFetch(`/tx/${txid}/status`);
  if (!res.ok) throw new Error(`Failed to fetch TX status: ${res.status}`);
  return res.json();
}

export async function getCurrentBlockHeight(): Promise<number> {
  const res = await mempoolFetch('/blocks/tip/height');
  if (!res.ok) throw new Error(`Failed to fetch block height: ${res.status}`);
  const height = parseInt(await res.text(), 10);
  // L3: Guard against NaN from non-numeric API response
  if (isNaN(height) || height < 0) throw new Error('Invalid block height from API');
  return height;
}

/** Provider list (with fallback) keyed by the bitcoin network name ord reports
 *  in its /status `chain` field. Unknown chains fall back to mainnet. */
function providersForChain(chain: string): string[] {
  switch (chain) {
    case 'testnet4': return PROVIDERS.testnet4;
    case 'testnet':
    case 'testnet3': return PROVIDERS.testnet3;
    case 'signet': return ['https://mempool.space/signet/api', 'https://mempool.emzy.de/signet/api'];
    default: return PROVIDERS.mainnet; // bitcoin / main / mainnet / unknown
  }
}

/** Fetch the chain tip height for an EXPLICIT network (by ord's reported `chain`
 *  name), independent of the session-active provider list. Lets callers such as
 *  the ord health probe measure lag against the SAME chain ord is indexing, with
 *  provider fallback and no dependency on setMempoolNetwork() (Punch List #2/#5). */
export async function getChainTipForChain(chain: string): Promise<number> {
  const res = await tryProviders(providersForChain(chain), '/blocks/tip/height');
  if (!res.ok) throw new Error(`Failed to fetch block height: ${res.status}`);
  const height = parseInt(await res.text(), 10);
  if (isNaN(height) || height < 0) throw new Error('Invalid block height from API');
  return height;
}

export async function getTxConfirmations(txid: string): Promise<number> {
  const [txStatus, tipHeight] = await Promise.all([
    getTxStatus(txid),
    getCurrentBlockHeight(),
  ]);
  if (!txStatus.confirmed || !txStatus.block_height) return 0;
  return tipHeight - txStatus.block_height + 1;
}

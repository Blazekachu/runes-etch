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

/** Detect network from address prefix and return the correct API base.
 *  Tries testnet4 first (current default for most wallets), falls back to testnet3. */
export function mempoolBaseForAddress(address?: string): string {
  if (address && (address.startsWith('tb1') || address.startsWith('2') || address.startsWith('m') || address.startsWith('n'))) {
    return MEMPOOL_TESTNET4;
  }
  return MEMPOOL_MAINNET;
}

let MEMPOOL_BASE = MEMPOOL_MAINNET;

/** Call once at wallet connect to set the API base for the session.
 *  For testnet addresses, probes testnet4 first, then falls back to testnet3. */
export async function setMempoolNetwork(address: string): Promise<void> {
  if (address && (address.startsWith('tb1') || address.startsWith('2') || address.startsWith('m') || address.startsWith('n'))) {
    // Try testnet4 first (current default for Leather, newer wallets)
    try {
      const res = await fetch(`${MEMPOOL_TESTNET4}/address/${encodeURIComponent(address)}/utxo`, { signal: AbortSignal.timeout(5000) });
      if (res.ok || res.status === 200) {
        MEMPOOL_BASE = MEMPOOL_TESTNET4;
        return;
      }
    } catch { /* fall through */ }
    // Fall back to testnet3
    MEMPOOL_BASE = MEMPOOL_TESTNET3;
    return;
  }
  MEMPOOL_BASE = MEMPOOL_MAINNET;
}

const FETCH_TIMEOUT_MS = 15000;

// L7: All fetches use a timeout to prevent hanging on unresponsive APIs
function fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  return fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
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
  const res = await fetchWithTimeout(`${MEMPOOL_BASE}/v1/fees/recommended`);
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
  const res = await fetchWithTimeout(`${MEMPOOL_BASE}/address/${encodeURIComponent(address)}/utxo`);
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

export async function broadcastTx(txHex: string): Promise<string> {
  if (!TX_HEX_RE.test(txHex)) throw new Error('Invalid transaction hex');
  const res = await fetchWithTimeout(`${MEMPOOL_BASE}/tx`, {
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
  const res = await fetchWithTimeout(`${MEMPOOL_BASE}/tx/${txid}/status`);
  if (!res.ok) throw new Error(`Failed to fetch TX status: ${res.status}`);
  return res.json();
}

export async function getCurrentBlockHeight(): Promise<number> {
  const res = await fetchWithTimeout(`${MEMPOOL_BASE}/blocks/tip/height`);
  if (!res.ok) throw new Error(`Failed to fetch block height: ${res.status}`);
  const height = parseInt(await res.text(), 10);
  // L3: Guard against NaN from non-numeric API response
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

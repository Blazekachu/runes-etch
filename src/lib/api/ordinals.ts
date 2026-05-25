import type { OrdRuneResponse, OrdInscriptionResponse, OrdOutputResponse, OrdSatResponse, ParentInscription, UtxoSatInfo } from '@/types';
import { mempoolBaseForAddress } from './mempool';

const ORD_BASE = 'https://ordinals.com';
const FETCH_TIMEOUT_MS = 15000;

/** Returns true if the current session is on testnet (set after wallet connect) */
let _isTestnet = false;
export function setOrdinalsTestnet(address: string): void {
  _isTestnet = address.startsWith('tb1') || address.startsWith('2') || address.startsWith('m') || address.startsWith('n');
}

function fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  return fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
}

const RUNE_NAME_RE = /^[A-Z]+$/;
const INSCRIPTION_ID_RE = /^[0-9a-f]{64}i\d+$/i;
const TXID_RE = /^[0-9a-f]{64}$/i;

export async function checkRuneNameAvailable(name: string): Promise<boolean> {
  if (!RUNE_NAME_RE.test(name)) throw new Error(`Invalid rune name: ${name}`);
  // ordinals.com is mainnet-only — skip on testnet (always "available")
  if (_isTestnet) return true;
  const res = await fetchWithTimeout(`${ORD_BASE}/rune/${encodeURIComponent(name)}`, {
    headers: { Accept: 'application/json' },
  });
  if (res.status === 404) return true;
  if (!res.ok) throw new Error(`Ord API error: ${res.status}`);
  return false;
}

export async function getInscription(
  inscriptionId: string
): Promise<OrdInscriptionResponse> {
  if (!INSCRIPTION_ID_RE.test(inscriptionId)) throw new Error(`Invalid inscription ID: ${inscriptionId}`);
  const res = await fetchWithTimeout(`${ORD_BASE}/inscription/${encodeURIComponent(inscriptionId)}`, {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`Inscription not found: ${inscriptionId}`);
  return res.json();
}

export async function getOutput(
  txid: string,
  vout: number
): Promise<OrdOutputResponse> {
  if (!TXID_RE.test(txid)) throw new Error(`Invalid txid: ${txid}`);
  if (!Number.isInteger(vout) || vout < 0) throw new Error(`Invalid vout: ${vout}`);
  const res = await fetchWithTimeout(`${ORD_BASE}/output/${encodeURIComponent(txid)}:${vout}`, {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`Output not found: ${txid}:${vout}`);
  return res.json();
}

/** Returns true if ord-based sat tracking is unavailable (testnet, no canonical ord indexer). */
export function isOrdinalsTestnet(): boolean {
  return _isTestnet;
}

/** Fetch a single sat's rarity / name / block from ord. */
export async function getSat(satNumber: number): Promise<OrdSatResponse> {
  if (!Number.isInteger(satNumber) || satNumber < 0) throw new Error(`Invalid sat number: ${satNumber}`);
  const res = await fetchWithTimeout(`${ORD_BASE}/sat/${satNumber}`, {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`Sat lookup failed: ${res.status}`);
  return res.json();
}

const LABEL_CONCURRENCY = 5;

/**
 * For each UTXO, fetch its first sat's rarity info via ord's /output then /sat.
 * Mainnet-only — testnet has no canonical ord indexer, returns empty map.
 * Skips UTXOs where ord doesn't return sat_ranges (unindexed / spent).
 */
export async function fetchUtxoSatInfo(
  utxos: Array<{ txid: string; vout: number }>
): Promise<Map<string, UtxoSatInfo>> {
  const result = new Map<string, UtxoSatInfo>();
  if (_isTestnet) return result;

  async function infoOne(utxo: { txid: string; vout: number }) {
    const key = `${utxo.txid}:${utxo.vout}`;
    try {
      const output = await getOutput(utxo.txid, utxo.vout);
      if (!output.sat_ranges || output.sat_ranges.length === 0) return;
      const firstSat = output.sat_ranges[0][0];
      const sat = await getSat(firstSat);
      result.set(key, {
        firstSat,
        rarity: sat.rarity,
        name: sat.name,
        block: sat.block,
      });
    } catch {
      // Leave unset — UI will show "?" / no badge for this UTXO
    }
  }

  for (let i = 0; i < utxos.length; i += LABEL_CONCURRENCY) {
    const batch = utxos.slice(i, i + LABEL_CONCURRENCY);
    await Promise.all(batch.map(infoOne));
  }
  return result;
}

export async function labelUtxos(
  utxos: Array<{ txid: string; vout: number }>
): Promise<Map<string, 'plain' | 'inscription' | 'rune' | 'unknown'>> {
  const labels = new Map<string, 'plain' | 'inscription' | 'rune' | 'unknown'>();

  async function labelOne(utxo: { txid: string; vout: number }) {
    const key = `${utxo.txid}:${utxo.vout}`;
    try {
      const output = await getOutput(utxo.txid, utxo.vout);
      if (output.inscriptions.length > 0) {
        labels.set(key, 'inscription');
      } else if (Object.keys(output.runes).length > 0) {
        labels.set(key, 'rune');
      } else {
        labels.set(key, 'plain');
      }
    } catch {
      labels.set(key, 'unknown');
    }
  }

  // Process in batches to avoid rate-limiting
  for (let i = 0; i < utxos.length; i += LABEL_CONCURRENCY) {
    const batch = utxos.slice(i, i + LABEL_CONCURRENCY);
    await Promise.all(batch.map(labelOne));
  }
  return labels;
}

/**
 * Re-resolve a parent inscription's current UTXO location at reveal time.
 * The parent may have moved since the commit was made (wallet consolidation,
 * trades, other inscriptions). NEVER trust stale data from bundle or initial session.
 */
export async function resolveParentForReveal(
  parentInscriptionId: string,
  userAddress: string
): Promise<
  | { status: 'ready'; parent: ParentInscription }
  | { status: 'moved'; currentAddress: string }
  | { status: 'not-found'; error: string }
> {
  try {
    const info = await getInscription(parentInscriptionId);
    const [txid, voutStr] = info.output.split(':');
    const vout = parseInt(voutStr, 10);

    const output = await getOutput(txid, vout);

    if (info.address !== userAddress) {
      return {
        status: 'moved',
        currentAddress: info.address,
      };
    }

    return {
      status: 'ready',
      parent: {
        inscriptionId: parentInscriptionId,
        txid,
        vout,
        value: output.value,
        address: info.address,
      },
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      status: 'not-found',
      error: `Parent inscription not found: ${message}`,
    };
  }
}

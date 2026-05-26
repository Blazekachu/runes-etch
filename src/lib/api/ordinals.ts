import type { OrdRuneResponse, OrdInscriptionResponse, OrdOutputResponse, OrdSatResponse, ParentInscription, UtxoSatInfo } from '@/types';
import { mempoolBaseForAddress } from './mempool';

const PUBLIC_ORD_DEFAULT = 'https://ordinals.com';

/**
 * Per-network ord base URL. Setting either env var lets the user point that network
 * at their own indexer (e.g. local testnet4 ord at 127.0.0.1:8080) while keeping the
 * other network on a public indexer. Legacy `NEXT_PUBLIC_ORD_BASE` still works as a
 * single-value fallback that applies to both networks (back-compat).
 */
const ORD_BASE_MAINNET = (
  process.env.NEXT_PUBLIC_ORD_BASE_MAINNET ||
  process.env.NEXT_PUBLIC_ORD_BASE ||
  PUBLIC_ORD_DEFAULT
).replace(/\/+$/, '');

const ORD_BASE_TESTNET = (
  process.env.NEXT_PUBLIC_ORD_BASE_TESTNET ||
  process.env.NEXT_PUBLIC_ORD_BASE ||
  PUBLIC_ORD_DEFAULT
).replace(/\/+$/, '');

const FETCH_TIMEOUT_MS = 15000;

/** Returns true if the current session is on testnet (set after wallet connect) */
let _isTestnet = false;
export function setOrdinalsTestnet(address: string): void {
  _isTestnet = address.startsWith('tb1') || address.startsWith('2') || address.startsWith('m') || address.startsWith('n');
}

/** Active ord base for the current session's network. */
function ordBase(): string {
  return _isTestnet ? ORD_BASE_TESTNET : ORD_BASE_MAINNET;
}

/**
 * True when the current network's ord base is the public default (ordinals.com).
 * Used to decide whether testnet calls should skip — they should only skip when
 * the user hasn't configured a custom testnet indexer (public ord is mainnet-only).
 */
function isPublicOrdForCurrentNetwork(): boolean {
  return ordBase() === PUBLIC_ORD_DEFAULT;
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
  // Skip only when on testnet AND no custom testnet indexer is configured.
  // Public ordinals.com is mainnet-only — querying it for a testnet name
  // returns mainnet data, which is meaningless. With a local testnet ord
  // configured via NEXT_PUBLIC_ORD_BASE_TESTNET, the check is meaningful.
  if (_isTestnet && isPublicOrdForCurrentNetwork()) return true;
  const res = await fetchWithTimeout(`${ordBase()}/rune/${encodeURIComponent(name)}`, {
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
  const res = await fetchWithTimeout(`${ordBase()}/inscription/${encodeURIComponent(inscriptionId)}`, {
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
  const res = await fetchWithTimeout(`${ordBase()}/output/${encodeURIComponent(txid)}:${vout}`, {
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
  const res = await fetchWithTimeout(`${ordBase()}/sat/${satNumber}`, {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`Sat lookup failed: ${res.status}`);
  return res.json();
}

const LABEL_CONCURRENCY = 5;

/**
 * For each UTXO, fetch its first sat's rarity info via ord's /output then /sat.
 * Skips on testnet ONLY when no custom indexer is configured — with a local
 * testnet ord, rarity info is meaningful and we should query it.
 */
export async function fetchUtxoSatInfo(
  utxos: Array<{ txid: string; vout: number }>
): Promise<Map<string, UtxoSatInfo>> {
  const result = new Map<string, UtxoSatInfo>();
  if (_isTestnet && isPublicOrdForCurrentNetwork()) return result;

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

export interface UtxoLabel {
  label: 'plain' | 'inscription' | 'rune' | 'unknown';
  /** Inscription IDs on this UTXO when label === 'inscription'. Empty otherwise. */
  inscriptionIds: string[];
}

export async function labelUtxos(
  utxos: Array<{ txid: string; vout: number }>
): Promise<Map<string, UtxoLabel>> {
  const labels = new Map<string, UtxoLabel>();

  async function labelOne(utxo: { txid: string; vout: number }) {
    const key = `${utxo.txid}:${utxo.vout}`;
    try {
      const output = await getOutput(utxo.txid, utxo.vout);
      if (output.inscriptions.length > 0) {
        labels.set(key, { label: 'inscription', inscriptionIds: output.inscriptions });
      } else if (Object.keys(output.runes).length > 0) {
        labels.set(key, { label: 'rune', inscriptionIds: [] });
      } else {
        labels.set(key, { label: 'plain', inscriptionIds: [] });
      }
    } catch {
      labels.set(key, { label: 'unknown', inscriptionIds: [] });
    }
  }

  // Process in batches to avoid rate-limiting
  for (let i = 0; i < utxos.length; i += LABEL_CONCURRENCY) {
    const batch = utxos.slice(i, i + LABEL_CONCURRENCY);
    await Promise.all(batch.map(labelOne));
  }
  return labels;
}

// ---------------------------------------------------------------------------
// Sat / inscription target resolution (manual-entry alternative to enumeration)
// ---------------------------------------------------------------------------

export type ResolveTargetInput =
  | { kind: 'sat'; satNumber: number }
  | { kind: 'inscription'; inscriptionId: string };

export type ResolveTargetResult =
  | {
      status: 'ok';
      txid: string;
      vout: number;
      offset: number;
      value: number;
      address: string;
      satNumber: number;
      inscriptionIds: string[];
      runeNames: string[];
    }
  | { status: 'wrong-offset'; address: string; offset: number; satNumber: number }
  | { status: 'not-owned'; currentAddress: string; satNumber: number }
  | { status: 'not-found'; reason: string };

/**
 * Resolve a sat number or inscription ID to its current UTXO via ord, then
 * verify ownership + offset-0 placement. Single network call per kind — no
 * enumeration. Works for hoarder addresses where /utxo + /txs walks fail.
 *
 * Caller passes the expected owner address (user's taproot). On 'ok' the
 * resolved UTXO can be used as vin[0] of commit/quick — the inscription /
 * rune will land on the user's chosen sat.
 */
export async function resolveTarget(
  input: ResolveTargetInput,
  expectedOwnerAddress: string,
): Promise<ResolveTargetResult> {
  try {
    let satNumber: number;
    let satpoint: string;
    let address: string;

    if (input.kind === 'sat') {
      satNumber = input.satNumber;
      const sat = await getSat(input.satNumber);
      satpoint = sat.satpoint;
      address = sat.address;
    } else {
      const insc = await getInscription(input.inscriptionId);
      satpoint = insc.satpoint;
      address = insc.address;
      satNumber = insc.sat;
    }

    if (address !== expectedOwnerAddress) {
      return { status: 'not-owned', currentAddress: address, satNumber };
    }

    // Satpoint format: "<txid>:<vout>:<offset>"
    const parts = satpoint.split(':');
    if (parts.length !== 3) {
      return { status: 'not-found', reason: `Invalid satpoint from ord: ${satpoint}` };
    }
    const [txid, voutStr, offsetStr] = parts;
    const vout = parseInt(voutStr, 10);
    const offset = parseInt(offsetStr, 10);
    if (!Number.isFinite(vout) || !Number.isFinite(offset)) {
      return { status: 'not-found', reason: `Could not parse satpoint: ${satpoint}` };
    }

    if (offset !== 0) {
      return { status: 'wrong-offset', address, offset, satNumber };
    }

    // Fetch the actual UTXO output to get value + label info
    const output = await getOutput(txid, vout);
    return {
      status: 'ok',
      txid,
      vout,
      offset,
      value: output.value,
      address,
      satNumber,
      inscriptionIds: output.inscriptions ?? [],
      runeNames: Object.keys(output.runes ?? {}),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { status: 'not-found', reason: msg };
  }
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

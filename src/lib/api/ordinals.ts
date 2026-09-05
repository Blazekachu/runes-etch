import type { OrdRuneResponse, OrdInscriptionResponse, OrdOutputResponse, OrdSatResponse, ParentInscription, UtxoSatInfo } from '@/types';
import type { BitcoinChain } from '@/lib/network';
import { ordChainName, walletChain } from '@/lib/network';
import { getChainTipForChain } from './mempool';
import { runeNameToU128 } from '@/lib/runes/names';
import type { WalletState } from '@/types';

const PUBLIC_ORD_DEFAULT = 'https://ordinals.com';

/**
 * Per-network ord base URL. Setting either env var lets the user point that network
 * at their own indexer (e.g. local signet ord at 127.0.0.1:8080) while keeping the
 * other network on a public indexer. Legacy `NEXT_PUBLIC_ORD_BASE_TESTNET` still
 * works as a fallback for signet (testnet4 era migration).
 */
const ORD_BASE_MAINNET = (
  process.env.NEXT_PUBLIC_ORD_BASE_MAINNET ||
  process.env.NEXT_PUBLIC_ORD_BASE ||
  PUBLIC_ORD_DEFAULT
).replace(/\/+$/, '');

const ORD_BASE_SIGNET = (
  process.env.NEXT_PUBLIC_ORD_BASE_SIGNET ||
  process.env.NEXT_PUBLIC_ORD_BASE_TESTNET ||
  process.env.NEXT_PUBLIC_ORD_BASE ||
  PUBLIC_ORD_DEFAULT
).replace(/\/+$/, '');

const ORD_BASE_REGTEST = (
  process.env.NEXT_PUBLIC_ORD_BASE_REGTEST ||
  'http://127.0.0.1:8081'
).replace(/\/+$/, '');

const FETCH_TIMEOUT_MS = 15000;

/** Active chain for the current session (set after wallet connect). */
let _activeChain: BitcoinChain = 'mainnet';

export function setOrdinalsChain(chain: BitcoinChain): void {
  _activeChain = chain;
}

/** @deprecated Use setOrdinalsChain(walletChain(wallet)). Address prefix alone cannot distinguish signet. */
export function setOrdinalsTestnet(address: string): void {
  _activeChain = address.startsWith('bcrt1') ? 'regtest'
    : address.startsWith('tb1') || address.startsWith('2') || address.startsWith('m') || address.startsWith('n')
      ? 'signet' : 'mainnet';
}

export function setOrdinalsForWallet(wallet: Pick<WalletState, 'network' | 'taprootAddress' | 'paymentAddress'>): void {
  setOrdinalsChain(walletChain(wallet));
}

/** Active ord base for the current session's network. */
function ordBase(): string {
  if (_activeChain === 'regtest') return ORD_BASE_REGTEST;
  if (_activeChain === 'signet') return ORD_BASE_SIGNET;
  return ORD_BASE_MAINNET;
}

function ordBaseForChain(chain: BitcoinChain): string {
  if (chain === 'regtest') return ORD_BASE_REGTEST;
  if (chain === 'signet') return ORD_BASE_SIGNET;
  return ORD_BASE_MAINNET;
}

/**
 * True when the current network's ord base is the public default (ordinals.com).
 * Used to decide whether non-mainnet calls should skip — they should only skip when
 * the user hasn't configured a custom indexer (public ord is mainnet-only).
 */
export function isPublicOrdForCurrentNetwork(): boolean {
  return ordBase() === PUBLIC_ORD_DEFAULT;
}

function isPublicOrdForChain(chain: BitcoinChain): boolean {
  return ordBaseForChain(chain) === PUBLIC_ORD_DEFAULT;
}

function fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  return fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
}

/**
 * Fetch from ord with JSON preference, HTML fallback.
 *
 * Public ordinals.com currently ships with `json api: false`, so
 * Accept application/json returns HTTP 406 for every endpoint. Local ord
 * instances with JSON enabled still prefer JSON. On 406 we retry without
 * forcing JSON and parse HTML dt/dd pages.
 */
async function ordFetch(url: string): Promise<Response> {
  const jsonRes = await fetchWithTimeout(url, {
    headers: { Accept: 'application/json' },
  });
  if (jsonRes.status !== 406) return jsonRes;
  return fetchWithTimeout(url, {
    headers: { Accept: '*/*' },
  });
}

function isJsonResponse(res: Response): boolean {
  const ct = res.headers.get('content-type') ?? '';
  return ct.includes('application/json') || ct.includes('+json');
}

/** Parse ord HTML pages that expose fields as `<dt>key</dt><dd>value</dd>`. */
function parseOrdHtmlDl(html: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /<dt>([^<]+)<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const key = m[1].trim().toLowerCase();
    const raw = m[2];
    // Prefer first href target for link-heavy values (address, satpoint, inscription ids).
    const href = raw.match(/href=\/?((?:inscription|address|sat|tx|output|block)\/[^"'\s>]+)/i)
      ?? raw.match(/href=\/?(inscription\/[0-9a-f]+i\d+)/i);
    let value = href
      ? href[1].replace(/^(inscription|address|sat|tx|output|block)\//i, '')
      : raw.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    // location / satpoint keep full "txid:vout:offset"
    if (key === 'location' || key === 'output' || key === 'id') {
      const collapsed = raw.replace(/<[^>]+>/g, '').replace(/\s+/g, '').trim();
      if (collapsed) value = collapsed;
    }
    out[key] = value;
  }
  return out;
}

async function readOrdJsonOrHtml(res: Response): Promise<
  | { kind: 'json'; data: unknown }
  | { kind: 'html'; fields: Record<string, string>; html: string }
> {
  const text = await res.text();
  const trimmed = text.trimStart();
  // Sniff JSON even when Content-Type is missing (common in tests / some proxies).
  if (isJsonResponse(res) || trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return { kind: 'json', data: JSON.parse(text) };
    } catch {
      /* fall through to HTML */
    }
  }
  return { kind: 'html', fields: parseOrdHtmlDl(text), html: text };
}

function statusFromOrdPayload(
  payload: { kind: 'json'; data: unknown } | { kind: 'html'; fields: Record<string, string> },
): { height: number | null; runeMinimum: bigint | null; chain?: string; unrecoverablyReorged?: boolean } {
  if (payload.kind === 'json') {
    const data = payload.data as {
      height?: number;
      minimum_rune_for_next_block?: string;
      chain?: string;
      unrecoverably_reorged?: boolean;
    };
    const minName = data.minimum_rune_for_next_block;
    return {
      height: typeof data.height === 'number' && Number.isFinite(data.height) ? data.height : null,
      runeMinimum: minName && /^[A-Z]+$/.test(minName) ? runeNameToU128(minName) : null,
      chain: data.chain,
      unrecoverablyReorged: data.unrecoverably_reorged === true,
    };
  }
  const h = payload.fields['height'];
  const height = h && /^\d+$/.test(h) ? parseInt(h, 10) : null;
  const minName = (payload.fields['minimum rune for next block'] ?? '').trim().toUpperCase();
  return {
    height,
    runeMinimum: /^[A-Z]+$/.test(minName) ? runeNameToU128(minName) : null,
    chain: payload.fields['chain'],
    unrecoverablyReorged: payload.fields['unrecoverably reorged'] === 'true',
  };
}

const RUNE_NAME_RE = /^[A-Z]+$/;
const INSCRIPTION_ID_RE = /^[0-9a-f]{64}i\d+$/i;
const TXID_RE = /^[0-9a-f]{64}$/i;

/**
 * Truth-telling rune name lookup result.
 *
 * `'unknown'` means ord 404'd but the indexer is too far behind chain tip to
 * trust that 404 — a name etched in a recent un-indexed block would look
 * identical to a never-etched name. Callers should refuse to broadcast on
 * `'unknown'` (fail-safe) or surface the lag context to the user.
 */
export type RuneNameStatus =
  | { state: 'available' }
  | { state: 'taken'; rune: OrdRuneResponse }
  | {
      state: 'unknown';
      reason: 'indexer-lagging' | 'indexer-wedged' | 'api-unavailable';
      indexerHeight: number;
      chainHeight: number;
      behind: number;
    };

/** ord must be within this many blocks of chain tip for a 404 to mean "name is free". */
const NAME_CHECK_LAG_THRESHOLD = 3;

/**
 * Look up a rune name's on-chain status with indexer-freshness awareness.
 *
 * Without the freshness cross-check, ord 404s indistinguishably for two cases:
 *  (a) name never etched (truly available)
 *  (b) name etched in a block ord hasn't indexed yet (NOT available)
 *
 * Case (b) would silently walk the user into broadcasting a cenotaph at full
 * fees on a duplicate name. We detect it by comparing ord's `/status.height`
 * against mempool's chain tip; if ord is more than `NAME_CHECK_LAG_THRESHOLD`
 * blocks behind, we return `'unknown'` with the lag numbers so the UI can
 * surface them. Otherwise the 404 is trustworthy and we return `'available'`.
 *
 * When the freshness measurement itself fails (mempool unreachable, ord status
 * 5xx), we fall back to the pre-#10 optimistic behavior of trusting the 404 —
 * not worse than what we shipped before.
 */
export async function getRuneNameStatus(name: string): Promise<RuneNameStatus> {
  if (!RUNE_NAME_RE.test(name)) throw new Error(`Invalid rune name: ${name}`);
  // Skip only when on signet AND no custom signet indexer is configured.
  // Public ordinals.com is mainnet-only — querying it for a signet name
  // returns mainnet data, which is meaningless. With a local signet ord
  // configured via NEXT_PUBLIC_ORD_BASE_SIGNET, the check is meaningful.
  if (_activeChain !== 'mainnet' && isPublicOrdForCurrentNetwork()) return { state: 'available' };

  const [runeRes, ordStatusRes] = await Promise.all([
    ordFetch(`${ordBase()}/rune/${encodeURIComponent(name)}`),
    ordFetch(`${ordBase()}/status`).catch(() => null),
  ]);

  if (runeRes.ok) {
    const text = await runeRes.text();
    const trimmed = text.trimStart();
    if (isJsonResponse(runeRes) || trimmed.startsWith('{')) {
      try {
        const rune = JSON.parse(text) as OrdRuneResponse;
        return { state: 'taken', rune };
      } catch {
        /* fall through to HTML */
      }
    }
    // HTML (json api disabled): 200 means the rune page exists → taken.
    const fields = parseOrdHtmlDl(text);
    return {
      state: 'taken',
      rune: {
        id: fields['id'] ?? '',
        name: name,
        spacedName: fields['name'] ?? name,
        number: fields['number'] ? parseInt(fields['number'], 10) || 0 : 0,
      },
    };
  }
  // Still 406 after HTML retry — rare; treat as unverified.
  if (runeRes.status === 406) {
    return {
      state: 'unknown',
      reason: 'api-unavailable',
      indexerHeight: -1,
      chainHeight: -1,
      behind: -1,
    };
  }
  if (runeRes.status !== 404) {
    throw new Error(`Ord API error on /rune/${encodeURIComponent(name)}: ${runeRes.status}`);
  }

  // 404. Decide whether to trust it. Two failure modes can produce a 404:
  //  - name truly never etched (return 'available')
  //  - indexer wedged on a reorg, OR indexer lagging — a recent etch we haven't
  //    indexed yet looks identical to never-etched.
  // Wedge beats lag — both can be true at once but the wedge is load-bearing.
  if (!ordStatusRes || !ordStatusRes.ok) {
    return { state: 'available' };
  }
  const statusPayload = await readOrdJsonOrHtml(ordStatusRes);
  const parsed = statusFromOrdPayload(statusPayload);
  const indexerHeight = parsed.height;
  if (indexerHeight === null) return { state: 'available' };
  const chainHeight = await getChainTipForChain(parsed.chain ?? ordChainName(_activeChain)).catch(() => -1);
  if (chainHeight < 0) return { state: 'available' };
  const behind = Math.max(0, chainHeight - indexerHeight);
  if (parsed.unrecoverablyReorged === true) {
    return { state: 'unknown', reason: 'indexer-wedged', indexerHeight, chainHeight, behind };
  }
  if (behind > NAME_CHECK_LAG_THRESHOLD) {
    return { state: 'unknown', reason: 'indexer-lagging', indexerHeight, chainHeight, behind };
  }
  return { state: 'available' };
}

/**
 * Backwards-compat wrapper. Returns `true` only when state is `'available'` —
 * `'unknown'` is treated as not-available (fail-safe: when in doubt, refuse to
 * broadcast). Existing callers gain lag protection automatically. For richer
 * UX that distinguishes the `'unknown'` state, call `getRuneNameStatus` directly.
 */
export async function checkRuneNameAvailable(name: string): Promise<boolean> {
  const status = await getRuneNameStatus(name);
  return status.state === 'available';
}

/**
 * Fetch the chain's current rune-name minimum directly from ord's status.
 * ord computes this per chain (mainnet vs signet vs regtest), so this is
 * authoritative for whatever chain the configured ord base points at.
 *
 * Used by callers to bypass the mainnet-only local `minimumAtHeight()`
 * computation, which is wrong on signet (Finding #11 — first observed on
 * testnet4: burned fees on silent cenotaph etches because the testnet branch
 * was permissive without ord's live minimum).
 *
 * Returns null on any failure (ord unreachable, malformed response, public
 * ord queried for a signet wallet). Callers should treat null as "couldn't
 * measure — fall back to the legacy behavior or refuse to broadcast".
 */
export async function getRuneMinimumFromOrd(): Promise<bigint | null> {
  return getRuneMinimumFromOrdForChain(_activeChain);
}

export async function getRuneMinimumFromOrdForWallet(
  wallet: Pick<WalletState, 'network' | 'taprootAddress' | 'paymentAddress'>,
): Promise<bigint | null> {
  return getRuneMinimumFromOrdForChain(walletChain(wallet));
}

/** @deprecated Prefer getRuneMinimumFromOrdForWallet. */
export async function getRuneMinimumFromOrdForAddress(address?: string): Promise<bigint | null> {
  return getRuneMinimumFromOrdForChain(
    address?.startsWith('bcrt1') ? 'regtest'
      : address && (address.startsWith('tb1') || address.startsWith('2') || address.startsWith('m') || address.startsWith('n'))
        ? 'signet' : 'mainnet',
  );
}

export async function getRuneStatusFromOrdForWallet(
  wallet: Pick<WalletState, 'network' | 'taprootAddress' | 'paymentAddress'>,
): Promise<{
  height: number | null;
  runeMinimum: bigint | null;
}> {
  const chain = walletChain(wallet);
  if (chain !== 'mainnet' && isPublicOrdForChain(chain)) return { height: null, runeMinimum: null };
  try {
    const res = await ordFetch(`${ordBaseForChain(chain)}/status`);
    if (!res.ok) return { height: null, runeMinimum: null };
    const payload = await readOrdJsonOrHtml(res);
    const parsed = statusFromOrdPayload(payload);
    return { height: parsed.height, runeMinimum: parsed.runeMinimum };
  } catch {
    return { height: null, runeMinimum: null };
  }
}

/** @deprecated Prefer getRuneStatusFromOrdForWallet. */
export async function getRuneStatusFromOrdForAddress(address?: string): Promise<{
  height: number | null;
  runeMinimum: bigint | null;
}> {
  const chain: BitcoinChain = address?.startsWith('bcrt1') ? 'regtest'
    : address && (address.startsWith('tb1') || address.startsWith('2') || address.startsWith('m') || address.startsWith('n'))
      ? 'signet' : 'mainnet';
  if (chain !== 'mainnet' && isPublicOrdForChain(chain)) return { height: null, runeMinimum: null };
  try {
    const res = await ordFetch(`${ordBaseForChain(chain)}/status`);
    if (!res.ok) return { height: null, runeMinimum: null };
    const payload = await readOrdJsonOrHtml(res);
    const parsed = statusFromOrdPayload(payload);
    return { height: parsed.height, runeMinimum: parsed.runeMinimum };
  } catch {
    return { height: null, runeMinimum: null };
  }
}

export async function getRuneMinimumFromOrdForChain(chain: BitcoinChain): Promise<bigint | null> {
  // Same skip as checkRuneNameAvailable: public ordinals.com is mainnet-only,
  // queries for a signet wallet would return mainnet rules.
  if (chain !== 'mainnet' && isPublicOrdForChain(chain)) return null;
  try {
    const res = await ordFetch(`${ordBaseForChain(chain)}/status`);
    if (!res.ok) return null;
    const payload = await readOrdJsonOrHtml(res);
    return statusFromOrdPayload(payload).runeMinimum;
  } catch {
    return null;
  }
}

/** @deprecated Prefer getRuneMinimumFromOrdForChain. `isNonMainnet` covers signet (was testnet4). */
export async function getRuneMinimumFromOrdForNetwork(isNonMainnet: boolean): Promise<bigint | null> {
  return getRuneMinimumFromOrdForChain(isNonMainnet ? 'signet' : 'mainnet');
}

export async function getInscription(
  inscriptionId: string
): Promise<OrdInscriptionResponse> {
  if (!INSCRIPTION_ID_RE.test(inscriptionId)) throw new Error(`Invalid inscription ID: ${inscriptionId}`);
  const res = await ordFetch(`${ordBase()}/inscription/${encodeURIComponent(inscriptionId)}`);
  if (!res.ok) throw new Error(`Inscription not found: ${inscriptionId}`);
  const payload = await readOrdJsonOrHtml(res);
  if (payload.kind === 'json') return payload.data as OrdInscriptionResponse;
  const fields = payload.fields;
  const satRaw = fields['sat'];
  const sat = satRaw && /^\d+$/.test(satRaw) ? parseInt(satRaw, 10) : null;
  const satpoint = fields['location'] || fields['satpoint'] || '';
  if (!fields['address'] || !satpoint) {
    throw new Error(`Inscription HTML missing address/location: ${inscriptionId}`);
  }
  return {
    id: fields['id'] || inscriptionId,
    address: fields['address'],
    output: fields['output'] || satpoint.split(':').slice(0, 2).join(':'),
    content_type: fields['content type'] || '',
    satpoint,
    sat,
  };
}

export async function getOutput(
  txid: string,
  vout: number
): Promise<OrdOutputResponse> {
  if (!TXID_RE.test(txid)) throw new Error(`Invalid txid: ${txid}`);
  if (!Number.isInteger(vout) || vout < 0) throw new Error(`Invalid vout: ${vout}`);
  const res = await ordFetch(`${ordBase()}/output/${encodeURIComponent(txid)}:${vout}`);
  if (!res.ok) throw new Error(`Output not found: ${txid}:${vout}`);
  const payload = await readOrdJsonOrHtml(res);
  if (payload.kind === 'json') return payload.data as OrdOutputResponse;
  const html = payload.html;
  const fields = payload.fields;
  const inscriptionIds = Array.from(
    html.matchAll(/href=\/?inscription\/([0-9a-f]+i\d+)/gi),
    (m) => m[1].toLowerCase(),
  );
  const value = fields['value'] && /^\d+$/.test(fields['value']) ? parseInt(fields['value'], 10) : 0;
  return {
    address: fields['address'] || '',
    inscriptions: [...new Set(inscriptionIds)],
    runes: {},
    value,
    // Public HTML pages omit sat_ranges when json api is off.
    sat_ranges: undefined,
  };
}

/** True when session chain is signet. */
export function isOrdinalsSignet(): boolean {
  return _activeChain === 'signet';
}

/** True when session chain is regtest. */
export function isOrdinalsRegtest(): boolean {
  return _activeChain === 'regtest';
}

/** True when session chain is any non-mainnet network. */
export function isOrdinalsNonMainnet(): boolean {
  return _activeChain !== 'mainnet';
}

/** @deprecated Use isOrdinalsSignet(). */
export function isOrdinalsTestnet(): boolean {
  return isOrdinalsSignet();
}

/** Fetch a single sat's rarity / name / block from ord. */
export async function getSat(satNumber: number): Promise<OrdSatResponse> {
  if (!Number.isInteger(satNumber) || satNumber < 0) throw new Error(`Invalid sat number: ${satNumber}`);
  const res = await ordFetch(`${ordBase()}/sat/${satNumber}`);
  if (!res.ok) throw new Error(`Sat lookup failed: ${res.status}`);
  const payload = await readOrdJsonOrHtml(res);
  if (payload.kind === 'json') return payload.data as OrdSatResponse;
  const fields = payload.fields;
  const rarity = (fields['rarity'] || 'common') as OrdSatResponse['rarity'];
  const block = fields['block'] && /^\d+$/.test(fields['block']) ? parseInt(fields['block'], 10) : 0;
  const satpoint = fields['location'] || '';
  if (!fields['address'] || !satpoint) {
    throw new Error(`Sat HTML missing address/location: ${satNumber}`);
  }
  return {
    number: satNumber,
    rarity,
    name: fields['name'] || '',
    block,
    cycle: fields['cycle'] ? parseInt(fields['cycle'], 10) || 0 : 0,
    epoch: fields['epoch'] ? parseInt(fields['epoch'], 10) || 0 : 0,
    period: fields['period'] ? parseInt(fields['period'], 10) || 0 : 0,
    decimal: fields['decimal'] || '',
    satpoint,
    address: fields['address'],
  };
}

const LABEL_CONCURRENCY = 5;

/**
 * For each UTXO, fetch its first sat's rarity info via ord's /output then /sat.
 * Skips on signet ONLY when no custom indexer is configured — with a local
 * signet ord, rarity info is meaningful and we should query it.
 */
export async function fetchUtxoSatInfo(
  utxos: Array<{ txid: string; vout: number }>
): Promise<Map<string, UtxoSatInfo>> {
  const result = new Map<string, UtxoSatInfo>();
  if (_activeChain !== 'mainnet' && isPublicOrdForCurrentNetwork()) return result;

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

function normalizeSatNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  return null;
}

function firstSatFromOutput(output: OrdOutputResponse): number | null {
  const range = output.sat_ranges?.[0];
  if (!range || range.length < 1) return null;
  const n = range[0];
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null;
}

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
      satNumber: number | null;
      inscriptionIds: string[];
      runeNames: string[];
    }
  | { status: 'wrong-offset'; address: string; offset: number; satNumber: number | null }
  | { status: 'not-owned'; currentAddress: string; satNumber: number | null }
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
    let satNumber: number | null;
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
      satNumber = normalizeSatNumber(insc.sat);
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
    if (satNumber === null) {
      satNumber = firstSatFromOutput(output);
    }
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
    // Current location lives in `satpoint` ("txid:vout:offset"). The legacy
    // `output` field is absent on some ord builds (#12) — satpoint is always present.
    const [txid, voutStr] = info.satpoint.split(':');
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

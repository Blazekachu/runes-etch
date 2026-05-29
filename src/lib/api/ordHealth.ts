import { getChainTipForChain } from './mempool';
import { isOrdinalsTestnet } from './ordinals';

const PUBLIC_ORD_DEFAULT = 'https://ordinals.com';
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

const FETCH_TIMEOUT_MS = 8000;

/** Threshold above which lag is surfaced as `lagging`; <= is treated as healthy. */
export const ORD_LAG_THRESHOLD = 3;

/**
 * Polled health probe for the configured ord indexer. Used by `OrdHealthBanner`
 * and any future consumer that needs a structured staleness signal.
 *
 * - `healthy`: ord is within `ORD_LAG_THRESHOLD` of chain tip AND
 *   `unrecoverably_reorged === false`.
 * - `lagging`: ord is more than `ORD_LAG_THRESHOLD` blocks behind, but NOT reorged.
 *   Indexer is still advancing; expect it to catch up.
 * - `wedged`: ord reports `unrecoverably_reorged: true`. Indexer halted.
 *   `getRuneNameStatus` and `getRuneMinimumFromOrd` should be treated as stale.
 * - `unreachable`: ord /status or mempool chain tip fetch failed. Banner shows a
 *   muted yellow info — cannot prove healthy, cannot prove broken.
 * - `skipped`: testnet wallet + public ord base = mainnet-only data, query would
 *   be meaningless. Banner stays hidden.
 *
 * Wedge beats lag — `unrecoverably_reorged: true` returns `wedged` regardless of
 * `behind` (a wedged indexer that happens to be at-tip is still wedged on the
 * next reorg).
 */
export type OrdHealthStatus =
  | { state: 'healthy'; indexerHeight: number; chainHeight: number }
  | { state: 'lagging'; indexerHeight: number; chainHeight: number; behind: number }
  | { state: 'wedged'; indexerHeight: number; chainHeight: number; behind: number }
  | { state: 'unreachable' }
  | { state: 'skipped' };

function ordBase(): string {
  return isOrdinalsTestnet() ? ORD_BASE_TESTNET : ORD_BASE_MAINNET;
}

function isPublicOrdForCurrentNetwork(): boolean {
  return ordBase() === PUBLIC_ORD_DEFAULT;
}

function fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  return fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
}

export async function getOrdHealth(): Promise<OrdHealthStatus> {
  if (isOrdinalsTestnet() && isPublicOrdForCurrentNetwork()) return { state: 'skipped' };

  try {
    // Fetch ord /status FIRST so we can read the chain it is actually indexing,
    // then measure lag against THAT chain's tip. Comparing ord's height against a
    // tip from a different network (the async-armed MEMPOOL_BASE could still be on
    // mainnet) produced a bogus `behind` and false "lagging" (Punch List #2).
    const statusRes = await fetchWithTimeout(`${ordBase()}/status`, {
      headers: { Accept: 'application/json' },
    });
    if (!statusRes.ok) return { state: 'unreachable' };
    const data = (await statusRes.json()) as {
      height?: number;
      unrecoverably_reorged?: boolean;
      chain?: string;
    };
    if (typeof data.height !== 'number') return { state: 'unreachable' };

    const chain = data.chain ?? (isOrdinalsTestnet() ? 'testnet4' : 'bitcoin');
    const chainHeight = await getChainTipForChain(chain);
    if (typeof chainHeight !== 'number') return { state: 'unreachable' };
    const indexerHeight = data.height;
    const reorged = data.unrecoverably_reorged === true;
    const behind = Math.max(0, chainHeight - indexerHeight);

    if (reorged) return { state: 'wedged', indexerHeight, chainHeight, behind };
    if (behind > ORD_LAG_THRESHOLD) return { state: 'lagging', indexerHeight, chainHeight, behind };
    return { state: 'healthy', indexerHeight, chainHeight };
  } catch {
    return { state: 'unreachable' };
  }
}

'use client';

import { useEffect, useState } from 'react';
import { useBuilderStore } from '@/store/builderStore';
import { getOrdHealth, type OrdHealthStatus } from '@/lib/api/ordHealth';

const POLL_INTERVAL_MS = 30_000;

/**
 * Polled health banner for the configured ord indexer. Rendered globally on the
 * v2 builder page so users notice wedged or lagging ord BEFORE they trust the
 * tool's name-uniqueness / rune-minimum checks (Finding #14 / Punch List #0b).
 *
 * - Healthy / unreachable / skipped: renders nothing.
 * - Lagging: yellow info — indexer is catching up, checks use lag-aware fallback.
 * - Wedged: red warning — indexer halted on a reorg, checks are stale until
 *   recovery (manual nuke + reindex on self-hosted ord; users on a public
 *   indexer should switch providers).
 *
 * Polling runs only while the wallet is connected — no point probing the
 * configured ord base on the landing page before the user has committed to a
 * network.
 */
export default function OrdHealthBanner() {
  const connected = useBuilderStore((s) => s.wallet.connected);
  const taprootAddress = useBuilderStore((s) => s.wallet.taprootAddress);
  const [health, setHealth] = useState<OrdHealthStatus | null>(null);

  useEffect(() => {
    if (!connected || !taprootAddress) {
      setHealth(null);
      return;
    }
    let cancelled = false;
    async function probe() {
      const h = await getOrdHealth();
      if (!cancelled) setHealth(h);
    }
    probe();
    const id = setInterval(probe, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [connected, taprootAddress]);

  if (!health) return null;
  if (health.state === 'healthy' || health.state === 'unreachable' || health.state === 'skipped') {
    return null;
  }

  if (health.state === 'wedged') {
    return (
      <div className="border-b border-red-700/60 bg-red-950/60 px-6 py-3 text-sm">
        <div className="max-w-3xl mx-auto flex items-start gap-2 text-red-200">
          <span aria-hidden>⚠</span>
          <div>
            <p className="font-semibold">Ord indexer wedged on a reorg.</p>
            <p className="text-xs text-red-300/80 mt-0.5">
              Indexer at block {health.indexerHeight.toLocaleString()}, chain tip at{' '}
              {health.chainHeight.toLocaleString()} ({health.behind} blocks behind).
              Rune-name uniqueness and minimum checks are stale until ord recovers.
              Verify names out-of-band via mempool.space, ordiscan, or ord.net before
              broadcasting.
            </p>
          </div>
        </div>
      </div>
    );
  }

  // lagging
  return (
    <div className="border-b border-yellow-700/50 bg-yellow-950/40 px-6 py-2 text-sm">
      <div className="max-w-3xl mx-auto flex items-start gap-2 text-yellow-200">
        <span aria-hidden>⏳</span>
        <div className="text-xs">
          Ord indexer is {health.behind} blocks behind chain tip (at{' '}
          {health.indexerHeight.toLocaleString()}, tip {health.chainHeight.toLocaleString()}).
          Name check will refuse to confirm recent etches until ord catches up.
        </div>
      </div>
    </div>
  );
}

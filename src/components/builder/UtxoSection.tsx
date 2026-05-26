'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { useBuilderStore } from '@/store/builderStore';
import { fetchUtxos, setMempoolNetwork } from '@/lib/api/mempool';
import { labelUtxos, fetchUtxoSatInfo, isOrdinalsTestnet, setOrdinalsTestnet, type UtxoLabel } from '@/lib/api/ordinals';
import type { LabeledUtxo, SatRarity } from '@/types';
import SectionWrapper from './SectionWrapper';

/** Estimate how many sats the commit TX needs (commit output + 1-input commit fee).
 *  Takes commit and reveal rates separately to match commit.ts — the reveal-budget
 *  portion of commit.vout[0] is sized by revealFeeRate, the commit fee by
 *  commitFeeRate. Caller should pass revealFeeRate = commitFeeRate when the user
 *  picks "match commit" (i.e. selectedRevealFeeRate is null). */
function estimateCost(
  commitFeeRate: number,
  revealFeeRate: number,
  hasInscription: boolean,
  hasParent: boolean,
  contentSize: number,
): number {
  // Reveal vbytes (same formula as commit.ts estimateRevealVBytes)
  const revealVB = Math.ceil(
    10.5 + 57.5 + Math.ceil(contentSize / 4) +
    (hasParent ? 57.5 : 0) +
    ((hasInscription ? 1 : 0) + (hasParent ? 1 : 0) + 1 + 1) * 43 + 50
  );
  const revealFee = Math.ceil(revealVB * revealFeeRate);
  const inscDust = hasInscription ? 546 : 0;
  const parentDust = hasParent ? 546 : 0;
  const commitOutputValue = revealFee + inscDust + parentDust + 546;

  // Commit TX fee estimate (1 input, 2 outputs)
  const commitVB = Math.ceil(10.5 + 68 + 2 * 43); // use P2WPKH size (worst case)
  const commitFee = Math.ceil(commitVB * commitFeeRate);

  return commitOutputValue + commitFee;
}

/** Pure function version of isSelectable (no hooks dependency).
 *  Reinscribe mode unlocks inscription-labeled UTXOs (rune-labeled stay blocked — burn risk). */
function isSelectableStatic(
  u: LabeledUtxo,
  parent: { txid: string; vout: number } | null,
  reinscribeMode: boolean,
): boolean {
  if (parent && u.txid === parent.txid && u.vout === parent.vout) return false;
  if (u.label === 'plain') return true;
  if (reinscribeMode && u.label === 'inscription') return true;
  return false;
}

export default function UtxoSection() {
  const wallet = useBuilderStore((s) => s.wallet);
  const utxos = useBuilderStore((s) => s.utxos);
  const setUtxos = useBuilderStore((s) => s.setUtxos);
  const toggleUtxoSelection = useBuilderStore((s) => s.toggleUtxoSelection);
  const parentInscription = useBuilderStore((s) => s.parentInscription);
  const detectedMode = useBuilderStore((s) => s.detectedMode);
  const inscriptionFile = useBuilderStore((s) => s.inscriptionFile);
  const delegateInscriptionId = useBuilderStore((s) => s.delegateInscriptionId);
  const selectedFeeRate = useBuilderStore((s) => s.selectedFeeRate);
  const selectedRevealFeeRate = useBuilderStore((s) => s.selectedRevealFeeRate);
  const primaryUtxoId = useBuilderStore((s) => s.primaryUtxoId);
  const setPrimaryUtxoId = useBuilderStore((s) => s.setPrimaryUtxoId);
  const effectivePrimaryUtxoId = useBuilderStore((s) => s.effectivePrimaryUtxoId);
  const utxoSatInfo = useBuilderStore((s) => s.utxoSatInfo);
  const mergeUtxoSatInfo = useBuilderStore((s) => s.mergeUtxoSatInfo);
  const reinscribeMode = useBuilderStore((s) => s.reinscribeMode);
  const setReinscribeMode = useBuilderStore((s) => s.setReinscribeMode);

  const [loading, setLoading] = useState(false);
  /** Taproot is fetched second and labelled via ord — separate spinner so the
   *  payment list (already shown) doesn't get blanked while the slow walk runs. */
  const [taprootLoading, setTaprootLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const autoSelectedRef = useRef(false);

  const isQuick = detectedMode === 'quick';
  const hasInscription = detectedMode === 'commit-reveal';
  const hasParent = !!parentInscription;
  const contentSize = inscriptionFile?.body.length ?? 0;

  // Estimated cost in sats. In commit-reveal mode, commit.vout[0] is sized by
  // selectedRevealFeeRate (the reveal budget) so the user pre-funds reveal at
  // up to that rate. When null, builder falls back to commit rate.
  const effectiveRevealRate = selectedRevealFeeRate ?? selectedFeeRate;
  const estCost = isQuick
    ? Math.ceil((10.5 + 68 + 3 * 43 + 50) * selectedFeeRate) + 546 // quick: fee + dust for premine
    : estimateCost(
        selectedFeeRate,
        effectiveRevealRate,
        hasInscription || !!delegateInscriptionId,
        hasParent,
        contentSize,
      );

  const selectedList = utxos.filter((u) => u.selected);
  const totalSats = selectedList.reduce((acc, u) => acc + u.value, 0);
  const funded = totalSats >= estCost;

  // Badge shown when section is collapsed
  const badge =
    selectedList.length > 0
      ? `${selectedList.length} UTXO${selectedList.length !== 1 ? 's' : ''} / ${totalSats.toLocaleString()} sats`
      : undefined;

  useEffect(() => {
    if (!wallet.taprootAddress || !wallet.connected) return;
    // Validate address format before fetching (guard against stale localStorage data)
    if (!/^[a-zA-Z0-9]{26,90}$/.test(wallet.taprootAddress)) return;
    if (utxos.length > 0) return;
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wallet.taprootAddress]);

  // Auto-select minimum UTXOs once loaded
  useEffect(() => {
    if (utxos.length === 0 || autoSelectedRef.current) return;
    if (utxos.some((u) => u.selected)) return; // user already has a selection
    autoSelectedRef.current = true;
    smartSelect(utxos);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [utxos]);

  // Fetch sat-rarity info for ALL plain UTXOs in the background (mainnet only — ordinals.com is
  // mainnet-exclusive). Covers both taproot AND payment sources: rare sats can end up in either
  // address if the user moved them with a non-ord-aware wallet, and we don't want to silently
  // miss them. Inscription/rune-labeled UTXOs are already filtered upstream.
  useEffect(() => {
    if (utxos.length === 0 || isOrdinalsTestnet()) return;
    const candidates = utxos.filter((u) => u.label === 'plain');
    const toFetch = candidates.filter((u) => !utxoSatInfo[`${u.txid}:${u.vout}`]);
    if (toFetch.length === 0) return;
    let cancelled = false;
    fetchUtxoSatInfo(toFetch).then((map) => {
      if (cancelled) return;
      mergeUtxoSatInfo(Object.fromEntries(map));
    }).catch(() => { /* swallowed — UI shows no badge for unfetched UTXOs */ });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [utxos]);

  async function load() {
    if (!wallet.taprootAddress) return;
    setLoading(true);
    setTaprootLoading(true);
    setError(null);
    autoSelectedRef.current = false;

    // Ensure module-level mempool/ordinals network state matches the address.
    // Critical when wallet was rehydrated from persist (handleConnect never ran).
    try {
      await setMempoolNetwork(wallet.taprootAddress);
      setOrdinalsTestnet(wallet.taprootAddress);
    } catch { /* setMempoolNetwork falls back to mainnet, non-fatal here */ }

    const errorMsgs: string[] = [];
    const friendly = (err: unknown): string => {
      const raw = err instanceof Error ? err.message : String(err);
      return /aborted|timed out/i.test(raw)
        ? 'mempool.space timed out (transient under load — Refresh).'
        : raw || 'Unknown error';
    };

    // Phase 1: PAYMENT first. Fast, what the user needs to pay fees.
    // Render immediately so the user isn't blocked by the slow taproot walk.
    let paymentLabeled: LabeledUtxo[] = [];
    if (wallet.paymentAddress && wallet.paymentAddress !== wallet.taprootAddress) {
      try {
        const paymentRaw = await fetchUtxos(wallet.paymentAddress);
        paymentLabeled = paymentRaw.map((u) => ({
          ...u,
          source: 'payment' as const,
          label: 'plain' as const,
          selected: false,
        }));
        setUtxos(paymentLabeled);
        setLoading(false); // overall loading stops as soon as payment is in
      } catch (err) {
        errorMsgs.push(`Payment UTXOs: ${friendly(err)}`);
        setLoading(false);
      }
    } else {
      setLoading(false);
    }

    // Phase 2: TAPROOT. Slow when address has many UTXOs (/utxo 400s, falls
    // back to /txs walk taking 30–60s). User can already pick fee UTXOs from
    // payment while this runs.
    try {
      const taprootRaw = await fetchUtxos(wallet.taprootAddress);

      let labelMap = new Map<string, UtxoLabel>();
      let labelWarning = false;
      if (taprootRaw.length > 0) {
        try { labelMap = await labelUtxos(taprootRaw); } catch { labelWarning = true; }
      }

      const seen = new Set(paymentLabeled.map((u) => `${u.txid}:${u.vout}`));
      const taprootLabeled: LabeledUtxo[] = [];
      for (const u of taprootRaw) {
        const key = `${u.txid}:${u.vout}`;
        if (seen.has(key)) continue;  // payment list already has it (shared output edge case)
        const info = labelMap.get(key);
        taprootLabeled.push({
          ...u,
          source: 'taproot' as const,
          label: info?.label ?? 'plain',
          selected: false,
          inscriptionIds: info?.inscriptionIds,
        });
      }

      // Merge: taproot at the top, payment below — UI groups them anyway.
      setUtxos([...taprootLabeled, ...paymentLabeled]);

      if (labelWarning) {
        errorMsgs.push('Taproot labels unavailable (ordinals API) — all shown as plain. Verify before selecting.');
      }
    } catch (err) {
      errorMsgs.push(`Taproot UTXOs: ${friendly(err)} You can still etch from payment UTXOs alone.`);
    } finally {
      setTaprootLoading(false);
    }

    if (errorMsgs.length > 0) setError(errorMsgs.join(' '));
  }

  /** Pick minimum UTXOs to cover estCost. Prefers payment, largest first. */
  const smartSelect = useCallback((currentUtxos: LabeledUtxo[]) => {
    const available = currentUtxos
      .filter((u) => isSelectableStatic(u, parentInscription, reinscribeMode))
      .sort((a, b) => {
        if (a.source !== b.source) return a.source === 'payment' ? -1 : 1;
        return b.value - a.value;
      });

    let accumulated = 0;
    const picked = new Set<string>();
    for (const u of available) {
      if (accumulated >= estCost) break;
      picked.add(`${u.txid}:${u.vout}`);
      accumulated += u.value;
    }

    const updated = currentUtxos.map((u) => ({
      ...u,
      selected: picked.has(`${u.txid}:${u.vout}`),
    }));
    setUtxos(updated);
  }, [estCost, parentInscription, setUtxos]);

  const canContinue = selectedList.length > 0;
  const selectableUtxos = utxos.filter((u) => isSelectableStatic(u, parentInscription, reinscribeMode));
  const paymentUtxos = utxos.filter((u) => u.source === 'payment');
  const taprootUtxos = utxos.filter((u) => u.source === 'taproot');

  function isParentUtxo(u: LabeledUtxo): boolean {
    return parentInscription !== null && u.txid === parentInscription.txid && u.vout === parentInscription.vout;
  }

  function truncateTxid(txid: string): string {
    return `${txid.slice(0, 8)}…${txid.slice(-8)}`;
  }

  function labelColor(label: LabeledUtxo['label']): string {
    switch (label) {
      case 'inscription': return 'text-purple-400';
      case 'rune': return 'text-orange-400';
      case 'unknown': return 'text-yellow-400';
      default: return 'text-gray-500';
    }
  }

  function labelText(label: LabeledUtxo['label']): string {
    switch (label) {
      case 'inscription': return 'inscription';
      case 'rune': return 'rune';
      case 'unknown': return 'unknown';
      default: return 'plain';
    }
  }

  function rarityColor(r: SatRarity): string {
    switch (r) {
      case 'mythic': return 'bg-yellow-400/20 text-yellow-300 border border-yellow-400/40';
      case 'legendary': return 'bg-red-500/20 text-red-300 border border-red-500/40';
      case 'epic': return 'bg-orange-500/20 text-orange-300 border border-orange-500/40';
      case 'rare': return 'bg-purple-500/20 text-purple-300 border border-purple-500/40';
      case 'uncommon': return 'bg-blue-500/20 text-blue-300 border border-blue-500/40';
      default: return 'bg-gray-800 text-gray-500';
    }
  }

  // Primary picker is only relevant when the etch will produce an inscription:
  // ord assigns the inscription to the first sat of vin 0, which is the primary UTXO.
  // For pure-rune etches the runestone is in OP_RETURN and sat ordering doesn't matter.
  const willInscribe = !!inscriptionFile || !!delegateInscriptionId;
  const effectivePrimaryId = effectivePrimaryUtxoId();

  function renderUtxoRow(u: LabeledUtxo) {
    const key = `${u.txid}:${u.vout}`;
    const isParent = isParentUtxo(u);
    const selectable = isSelectableStatic(u, parentInscription, reinscribeMode);
    const isExplicitPrimary = primaryUtxoId === key;
    const isEffectivePrimary = effectivePrimaryId === key;

    return (
      <div
        key={key}
        role="button"
        tabIndex={selectable ? 0 : -1}
        onClick={() => selectable && toggleUtxoSelection(u.txid, u.vout)}
        onKeyDown={(e) => {
          if (selectable && (e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault();
            toggleUtxoSelection(u.txid, u.vout);
          }
        }}
        className={`w-full flex items-center gap-3 px-4 py-3 text-left transition-colors border-b border-gray-800 last:border-b-0 ${
          !selectable
            ? 'bg-gray-900/50 opacity-50 cursor-not-allowed'
            : u.selected
            ? 'bg-orange-500/10 hover:bg-orange-500/15 cursor-pointer'
            : 'bg-gray-900 hover:bg-gray-800 cursor-pointer'
        }`}
      >
        <span className={`w-4 h-4 rounded border shrink-0 flex items-center justify-center transition-colors ${
          u.selected ? 'border-orange-500 bg-orange-500' : 'border-gray-600'
        }`}>
          {u.selected && (
            <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
            </svg>
          )}
        </span>
        <span className="font-mono text-xs text-gray-300 flex-1 min-w-0">{truncateTxid(u.txid)}:{u.vout}</span>
        <span className="font-mono text-xs text-gray-300 shrink-0">{u.value.toLocaleString()} sats</span>
        {/* Rarity badge (mainnet taproot only, non-common). Common/unfetched sats show nothing. */}
        {(() => {
          const info = utxoSatInfo[key];
          if (!info || info.rarity === 'common') return null;
          return (
            <span
              className={`shrink-0 rounded px-1.5 py-0.5 text-xs font-semibold ${rarityColor(info.rarity)}`}
              title={`First sat: ${info.firstSat.toLocaleString()} (block ${info.block}, name ${info.name})`}
            >
              {info.rarity}
            </span>
          );
        })()}
        <span className={`text-xs font-medium shrink-0 ${labelColor(u.label)}`}>{labelText(u.label)}</span>
        {isParent && (
          <span className="shrink-0 rounded bg-purple-500/20 px-1.5 py-0.5 text-xs text-purple-400 font-semibold">parent</span>
        )}
        {/* Existing inscription IDs on this UTXO (reinscribe context) */}
        {u.label === 'inscription' && u.inscriptionIds && u.inscriptionIds.length > 0 && (
          <span
            className="shrink-0 font-mono text-xs text-purple-300"
            title={u.inscriptionIds.join('\n')}
          >
            {u.inscriptionIds[0].slice(0, 6)}…i{u.inscriptionIds[0].split('i').pop()}
            {u.inscriptionIds.length > 1 && ` +${u.inscriptionIds.length - 1}`}
          </span>
        )}
        {/* Primary star — only shown when there will be an inscription and the row is selected.
            Click sets/clears explicit primary. Empty star + (auto) marks the auto-fallback. */}
        {willInscribe && u.selected && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setPrimaryUtxoId(isExplicitPrimary ? null : key);
            }}
            title={
              isExplicitPrimary
                ? 'Primary UTXO (click to clear — will auto-fall-back to largest)'
                : isEffectivePrimary
                ? 'Auto-selected as primary (largest selected). Click to lock this choice.'
                : 'Click to make this the primary UTXO (its sat 0 receives the inscription)'
            }
            className={`shrink-0 rounded px-1.5 py-0.5 text-xs font-semibold transition-colors ${
              isExplicitPrimary
                ? 'text-yellow-300 hover:text-yellow-200'
                : isEffectivePrimary
                ? 'text-yellow-500/60 hover:text-yellow-400'
                : 'text-gray-600 hover:text-yellow-400'
            }`}
          >
            {isExplicitPrimary ? '★ Primary' : isEffectivePrimary ? '★ auto' : '☆'}
          </button>
        )}
      </div>
    );
  }

  return (
    <SectionWrapper sectionKey="utxo" title="UTXO Selection" badge={badge}>
      <div className="flex flex-col gap-4">
        {/* Header with refresh */}
        <div className="flex items-start justify-between gap-4">
          <p className="text-gray-400 text-sm">UTXOs are auto-selected to cover the estimated cost. Adjust if needed.</p>
          <button
            onClick={load}
            disabled={loading}
            className="shrink-0 rounded-lg border border-gray-700 px-3 py-1.5 text-xs font-medium text-gray-400 hover:border-gray-500 hover:text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {loading ? 'Loading…' : 'Refresh'}
          </button>
        </div>

        {/* Primary-UTXO explainer — only when an inscription is in play */}
        {willInscribe && (
          <div className="rounded-lg border border-yellow-500/20 bg-yellow-500/5 px-4 py-3 flex flex-col gap-1">
            <p className="text-xs text-yellow-300 font-semibold">★ Primary UTXO controls the inscribed sat</p>
            <p className="text-xs text-gray-400">
              The primary UTXO becomes vin 0 of the commit TX. Ord assigns the inscription to its
              first sat (offset 0). To inscribe on a specific rare sat, pre-isolate it in your ord
              wallet so it sits at offset 0 of a UTXO, then pick that UTXO as primary here.
            </p>
            <p className="text-xs text-gray-500">
              No pick? The largest selected UTXO is auto-promoted (marked “★ auto”).
            </p>
          </div>
        )}

        {/* Reinscribe-mode toggle — only when an inscription is in play */}
        {willInscribe && (
          <div className="flex items-center justify-between rounded-lg border border-gray-700 bg-gray-900 px-4 py-3">
            <div className="flex flex-col gap-0.5 min-w-0">
              <p className="text-sm font-medium text-white">Reinscribe on existing inscription</p>
              <p className="text-xs text-gray-500">
                Unlocks inscription-labeled UTXOs. The selected inscription UTXO becomes primary — your
                new etch stacks as a subsequent inscription on the same sat (post-jubilee).
              </p>
            </div>
            <button
              onClick={() => setReinscribeMode(!reinscribeMode)}
              role="switch"
              aria-checked={reinscribeMode}
              className={`shrink-0 relative inline-flex h-6 w-11 cursor-pointer rounded-full border-2 border-transparent transition-colors focus:outline-none ${
                reinscribeMode ? 'bg-orange-500' : 'bg-gray-700'
              }`}
            >
              <span
                className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition-transform ${
                  reinscribeMode ? 'translate-x-5' : 'translate-x-0'
                }`}
              />
            </button>
          </div>
        )}

        {/* Estimated cost */}
        <div className="rounded-lg border border-gray-800 bg-gray-900 px-4 py-3 flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="text-sm text-gray-400">Estimated cost</span>
            <span className="font-mono text-sm text-white font-semibold">~{estCost.toLocaleString()} sats</span>
          </div>
          {/* Funding progress bar */}
          {selectedList.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <div className="h-2 rounded-full bg-gray-800 overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all duration-300 ${funded ? 'bg-green-500' : 'bg-orange-500'}`}
                  style={{ width: `${Math.min(100, (totalSats / estCost) * 100)}%` }}
                />
              </div>
              <div className="flex items-center justify-between text-xs">
                <span className={funded ? 'text-green-400' : 'text-orange-400'}>
                  {funded ? 'Funded' : `Need ${(estCost - totalSats).toLocaleString()} more sats`}
                </span>
                <span className="font-mono text-gray-400">{totalSats.toLocaleString()} / {estCost.toLocaleString()}</span>
              </div>
            </div>
          )}
          <p className="text-xs text-gray-600">
            Includes {isQuick ? 'TX fee + dust' : 'commit fee + reveal fee + dust outputs'}. Actual cost may vary slightly.
          </p>
        </div>

        {error && (
          <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400">{error}</div>
        )}

        {loading && utxos.length === 0 && (
          <div className="flex flex-col gap-2">
            {Array.from({ length: 2 }).map((_, i) => (
              <div key={i} className="h-14 rounded-lg bg-gray-900 animate-pulse" />
            ))}
            <p className="text-xs text-gray-500 mt-1">Loading payment UTXOs…</p>
          </div>
        )}

        {!loading && utxos.length === 0 && !error && (
          <div className="rounded-lg border border-gray-700 bg-gray-900 px-6 py-8 text-center text-sm text-gray-500">
            No UTXOs found on either address.
          </div>
        )}

        {/* Action buttons */}
        {utxos.length > 0 && (
          <div className="flex gap-2">
            <button
              onClick={() => smartSelect(utxos)}
              disabled={selectableUtxos.length === 0}
              className="rounded-lg border border-orange-500 px-4 py-2 text-sm font-semibold text-orange-500 hover:bg-orange-500 hover:text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              Smart Select
            </button>
            <button
              onClick={() => setUtxos(utxos.map((u) => ({ ...u, selected: isSelectableStatic(u, parentInscription, reinscribeMode) })))}
              disabled={selectableUtxos.length === 0}
              className="rounded-lg border border-gray-700 px-4 py-2 text-sm font-semibold text-gray-400 hover:border-gray-500 hover:text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              Select All
            </button>
            {selectedList.length > 0 && (
              <button
                onClick={() => setUtxos(utxos.map((u) => ({ ...u, selected: false })))}
                className="rounded-lg border border-gray-700 px-4 py-2 text-sm font-semibold text-gray-400 hover:border-gray-500 hover:text-white transition-colors"
              >
                Clear
              </button>
            )}
          </div>
        )}

        {/* Payment address UTXOs */}
        {paymentUtxos.length > 0 && (
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2 px-1 mb-1">
              <span className="text-xs font-semibold uppercase tracking-wider text-blue-400">Payment</span>
              <span className="font-mono text-xs text-gray-500 truncate">{wallet.paymentAddress}</span>
            </div>
            <div className="rounded-lg border border-gray-800 overflow-hidden">
              {paymentUtxos.map(renderUtxoRow)}
            </div>
          </div>
        )}

        {/* Taproot address UTXOs */}
        {(taprootUtxos.length > 0 || taprootLoading) && (
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2 px-1 mb-1">
              <span className="text-xs font-semibold uppercase tracking-wider text-orange-400">Taproot</span>
              <span className="font-mono text-xs text-gray-500 truncate">{wallet.taprootAddress}</span>
              {taprootLoading && (
                <span className="text-xs text-gray-500 italic shrink-0">loading…</span>
              )}
            </div>
            {taprootUtxos.length > 0 && (
              <div className="rounded-lg border border-gray-800 overflow-hidden">
                {taprootUtxos.map(renderUtxoRow)}
              </div>
            )}
            {taprootLoading && taprootUtxos.length === 0 && (
              <div className="flex flex-col gap-2">
                {Array.from({ length: 3 }).map((_, i) => (
                  <div key={i} className="h-14 rounded-lg bg-gray-900 animate-pulse" />
                ))}
                <p className="text-xs text-gray-500 mt-1">
                  Walking transaction history for taproot — can take 30–60 seconds on
                  active addresses. Payment UTXOs above are ready; you can start picking
                  fee UTXOs now.
                </p>
              </div>
            )}
          </div>
        )}

        {/* Selection summary */}
        {selectedList.length > 0 && (
          <div className="rounded-lg border border-gray-700 bg-gray-900 px-4 py-3 flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <span className="text-sm text-gray-400">
                {selectedList.length} UTXO{selectedList.length !== 1 ? 's' : ''} selected
              </span>
              <span className="font-mono text-sm text-white font-semibold">
                {totalSats.toLocaleString()} sats
              </span>
            </div>
            {willInscribe && effectivePrimaryId && (
              <div className="flex items-center justify-between text-xs">
                <span className="text-gray-500">
                  Inscribes on sat 0 of{' '}
                  <span className={primaryUtxoId ? 'text-yellow-300' : 'text-yellow-500/60'}>
                    {primaryUtxoId ? 'primary' : 'auto-primary'}
                  </span>
                </span>
                <span className="font-mono text-gray-400">{effectivePrimaryId.slice(0, 8)}…:{effectivePrimaryId.split(':')[1]}</span>
              </div>
            )}
            {/* Affirmation when primary's first sat is non-common — surface the rarity loudly. */}
            {willInscribe && effectivePrimaryId && utxoSatInfo[effectivePrimaryId] && utxoSatInfo[effectivePrimaryId].rarity !== 'common' && (
              <div className={`rounded px-2 py-1.5 text-xs font-medium ${rarityColor(utxoSatInfo[effectivePrimaryId].rarity)}`}>
                ★ Will inscribe on a <strong>{utxoSatInfo[effectivePrimaryId].rarity}</strong> sat — block {utxoSatInfo[effectivePrimaryId].block}, named <span className="font-mono">{utxoSatInfo[effectivePrimaryId].name}</span>
              </div>
            )}
            {/* Reinscribe affirmation — when primary is an inscription UTXO */}
            {willInscribe && reinscribeMode && (() => {
              const primary = selectedList.find((u) => `${u.txid}:${u.vout}` === effectivePrimaryId);
              if (!primary || primary.label !== 'inscription' || !primary.inscriptionIds?.length) return null;
              return (
                <div className="rounded border border-purple-500/40 bg-purple-500/10 px-2 py-1.5 text-xs text-purple-200 flex flex-col gap-0.5">
                  <span>
                    ★ Reinscribing — new etch will stack on the sat already holding{' '}
                    <span className="font-mono">{primary.inscriptionIds.length} inscription{primary.inscriptionIds.length > 1 ? 's' : ''}</span>
                  </span>
                  <span className="text-purple-300/80 font-mono break-all">
                    Existing: {primary.inscriptionIds[0]}
                    {primary.inscriptionIds.length > 1 && ` (+${primary.inscriptionIds.length - 1} more)`}
                  </span>
                  <span className="text-purple-300/60">
                    Originals are preserved on the same sat; your new inscription becomes seq #{primary.inscriptionIds.length}.
                  </span>
                </div>
              );
            })()}
            {/* Soft warning — reinscribe mode is on but no inscription UTXO is primary */}
            {willInscribe && reinscribeMode && (() => {
              const primary = selectedList.find((u) => `${u.txid}:${u.vout}` === effectivePrimaryId);
              if (primary?.label === 'inscription') return null;
              return (
                <div className="rounded border border-yellow-500/40 bg-yellow-500/10 px-2 py-1.5 text-xs text-yellow-300">
                  Reinscribe mode on, but primary isn’t an inscription UTXO. Select an inscription UTXO — it’ll auto-promote to primary.
                </div>
              );
            })()}
            <div className="flex items-center justify-between text-xs">
              <span className="text-gray-500">Change returns to</span>
              <span className="font-mono text-gray-400">payment address</span>
            </div>
          </div>
        )}

        {/* Not enough funds warning */}
        {canContinue && !funded && (
          <div className="rounded-lg border border-yellow-500/30 bg-yellow-500/10 px-4 py-3 text-xs text-yellow-400">
            Selected amount may not cover the full cost. The transaction could fail with &quot;insufficient funds.&quot;
          </div>
        )}
      </div>
    </SectionWrapper>
  );
}

'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { useEtchStore } from '@/store/etchStore';
import { fetchUtxos } from '@/lib/api/mempool';
import { labelUtxos, type UtxoLabel } from '@/lib/api/ordinals';
import type { LabeledUtxo } from '@/types';

/** Estimate how many sats the commit TX needs (commit output + 1-input commit fee). */
function estimateCost(
  feeRate: number,
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
  const revealFee = Math.ceil(revealVB * feeRate);
  const inscDust = hasInscription ? 546 : 0;
  const parentDust = hasParent ? 546 : 0;
  const commitOutputValue = revealFee + inscDust + parentDust + 546;

  // Commit TX fee estimate (1 input, 2 outputs)
  const commitVB = Math.ceil(10.5 + 68 + 2 * 43); // use P2WPKH size (worst case)
  const commitFee = Math.ceil(commitVB * feeRate);

  return commitOutputValue + commitFee;
}

export default function UtxoSelector({ onNext, onBack }: { onNext?: () => void; onBack?: () => void }) {
  const wallet = useEtchStore((s) => s.wallet);
  const utxos = useEtchStore((s) => s.utxos);
  const setUtxos = useEtchStore((s) => s.setUtxos);
  const toggleUtxoSelection = useEtchStore((s) => s.toggleUtxoSelection);
  const parentInscription = useEtchStore((s) => s.parentInscription);
  const etchMode = useEtchStore((s) => s.etchMode);
  const inscriptionFile = useEtchStore((s) => s.inscriptionFile);
  const delegateInscriptionId = useEtchStore((s) => s.delegateInscriptionId);
  const selectedFeeRate = useEtchStore((s) => s.selectedFeeRate);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const autoSelectedRef = useRef(false);

  const hasInscription = etchMode === 'full' || etchMode === 'no-parent';
  const hasParent = !!parentInscription;
  const contentSize = inscriptionFile?.body.length ?? 0;
  // Estimated cost in sats
  const estCost = estimateCost(selectedFeeRate, hasInscription || !!delegateInscriptionId, hasParent, contentSize);

  useEffect(() => {
    if (!wallet.taprootAddress) return;
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

  async function load() {
    setLoading(true);
    setError(null);
    autoSelectedRef.current = false;
    try {
      const [taprootRaw, paymentRaw] = await Promise.all([
        fetchUtxos(wallet.taprootAddress),
        wallet.paymentAddress && wallet.paymentAddress !== wallet.taprootAddress
          ? fetchUtxos(wallet.paymentAddress)
          : Promise.resolve([]),
      ]);

      const seen = new Set<string>();
      const allRaw = [];
      for (const u of taprootRaw) {
        const key = `${u.txid}:${u.vout}`;
        if (!seen.has(key)) { seen.add(key); allRaw.push({ ...u, source: 'taproot' as const }); }
      }
      for (const u of paymentRaw) {
        const key = `${u.txid}:${u.vout}`;
        if (!seen.has(key)) { seen.add(key); allRaw.push({ ...u, source: 'payment' as const }); }
      }

      const taprootList = allRaw.filter((u) => u.source === 'taproot');
      const paymentList = allRaw.filter((u) => u.source === 'payment');

      // labelUtxos returns Map<string, UtxoLabel> where UtxoLabel = { label, inscriptionIds }
      // (refactored when bundle resume needed the inscription IDs). Wizard only consumes
      // the `label` string here.
      let labelMap = new Map<string, UtxoLabel>();
      let labelWarning = false;
      if (taprootList.length > 0) {
        try { labelMap = await labelUtxos(taprootList); } catch { labelWarning = true; }
      }

      const labeled: LabeledUtxo[] = [
        ...taprootList.map((u) => ({
          ...u,
          label: labelMap.get(`${u.txid}:${u.vout}`)?.label ?? 'plain',
          selected: false,
        })),
        ...paymentList.map((u) => ({
          ...u,
          label: 'plain' as const,
          selected: false,
        })),
      ];

      setUtxos(labeled);
      if (labelWarning) {
        setError('Could not label taproot UTXOs (ordinals API unavailable). All shown as plain — be careful not to spend inscriptions or runes.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load UTXOs');
    } finally {
      setLoading(false);
    }
  }

  /** Pick minimum UTXOs to cover estCost. Prefers payment, largest first. */
  const smartSelect = useCallback((currentUtxos: LabeledUtxo[]) => {
    const available = currentUtxos
      .filter((u) => isSelectableStatic(u, parentInscription))
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

  const selectedList = utxos.filter((u) => u.selected);
  const totalSats = selectedList.reduce((acc, u) => acc + u.value, 0);
  const canContinue = selectedList.length > 0;
  const funded = totalSats >= estCost;

  const selectableUtxos = utxos.filter((u) => isSelectableStatic(u, parentInscription));
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

  function renderUtxoRow(u: LabeledUtxo) {
    const key = `${u.txid}:${u.vout}`;
    const isParent = isParentUtxo(u);
    const selectable = isSelectableStatic(u, parentInscription);
    return (
      <button
        key={key}
        onClick={() => selectable && toggleUtxoSelection(u.txid, u.vout)}
        disabled={!selectable}
        className={`w-full flex items-center gap-3 px-4 py-3 text-left transition-colors border-b border-gray-800 last:border-b-0 ${
          !selectable
            ? 'bg-gray-900/50 opacity-50 cursor-not-allowed'
            : u.selected
            ? 'bg-orange-500/10 hover:bg-orange-500/15'
            : 'bg-gray-900 hover:bg-gray-800'
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
        <span className={`text-xs font-medium shrink-0 ${labelColor(u.label)}`}>{labelText(u.label)}</span>
        {isParent && (
          <span className="shrink-0 rounded bg-purple-500/20 px-1.5 py-0.5 text-xs text-purple-400 font-semibold">parent</span>
        )}
      </button>
    );
  }

  return (
    <div className="flex flex-col gap-6 py-8 max-w-xl mx-auto w-full">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold text-white mb-1">Fund Transaction</h2>
          <p className="text-gray-400 text-sm">UTXOs are auto-selected to cover the estimated cost. Adjust if needed.</p>
        </div>
        <button
          onClick={load}
          disabled={loading}
          className="shrink-0 rounded-lg border border-gray-700 px-3 py-1.5 text-xs font-medium text-gray-400 hover:border-gray-500 hover:text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>

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
          Includes commit fee + reveal fee + dust outputs. Actual cost may vary slightly.
        </p>
      </div>

      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400">{error}</div>
      )}

      {loading && utxos.length === 0 && (
        <div className="flex flex-col gap-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-14 rounded-lg bg-gray-900 animate-pulse" />
          ))}
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
            onClick={() => setUtxos(utxos.map((u) => ({ ...u, selected: isSelectableStatic(u, parentInscription) })))}
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
      {taprootUtxos.length > 0 && (
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2 px-1 mb-1">
            <span className="text-xs font-semibold uppercase tracking-wider text-orange-400">Taproot</span>
            <span className="font-mono text-xs text-gray-500 truncate">{wallet.taprootAddress}</span>
          </div>
          <div className="rounded-lg border border-gray-800 overflow-hidden">
            {taprootUtxos.map(renderUtxoRow)}
          </div>
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
          <div className="flex items-center justify-between text-xs">
            <span className="text-gray-500">Change returns to</span>
            <span className="font-mono text-gray-400">
              payment address
            </span>
          </div>
        </div>
      )}

      {/* Not enough funds warning */}
      {canContinue && !funded && (
        <div className="rounded-lg border border-yellow-500/30 bg-yellow-500/10 px-4 py-3 text-xs text-yellow-400">
          Selected amount may not cover the full cost. The transaction could fail with &quot;insufficient funds.&quot;
        </div>
      )}

      {/* Navigation */}
      <div className="flex gap-3 pt-2">
        <button
          onClick={onBack}
          className="rounded-lg border border-gray-700 px-6 py-2.5 text-sm font-semibold text-gray-300 hover:border-gray-500 hover:text-white transition-colors"
        >
          Back
        </button>
        <button
          onClick={onNext}
          disabled={!canContinue}
          className="flex-1 rounded-lg bg-orange-500 hover:bg-orange-400 active:bg-orange-600 disabled:opacity-40 disabled:cursor-not-allowed px-6 py-2.5 font-semibold text-white transition-colors"
        >
          Continue
        </button>
      </div>
    </div>
  );
}

/** Pure function version of isSelectable (no hooks dependency) */
function isSelectableStatic(u: LabeledUtxo, parent: { txid: string; vout: number } | null): boolean {
  if (parent && u.txid === parent.txid && u.vout === parent.vout) return false;
  return u.label === 'plain';
}

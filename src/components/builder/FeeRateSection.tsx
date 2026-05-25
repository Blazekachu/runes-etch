'use client';

import { useEffect, useState } from 'react';
import { useBuilderStore } from '@/store/builderStore';
import { fetchFeeRates } from '@/lib/api/mempool';
import SectionWrapper from './SectionWrapper';

type FeeMode = 'economy' | 'normal' | 'fast' | 'custom';

export default function FeeRateSection() {
  const feeRates = useBuilderStore((s) => s.feeRates);
  const setFeeRates = useBuilderStore((s) => s.setFeeRates);
  const selectedFeeRate = useBuilderStore((s) => s.selectedFeeRate);
  const setSelectedFeeRate = useBuilderStore((s) => s.setSelectedFeeRate);
  const selectedRevealFeeRate = useBuilderStore((s) => s.selectedRevealFeeRate);
  const setSelectedRevealFeeRate = useBuilderStore((s) => s.setSelectedRevealFeeRate);
  const detectedMode = useBuilderStore((s) => s.detectedMode);

  const [commitCustom, setCommitCustom] = useState('');
  const [commitMode, setCommitMode] = useState<FeeMode>('normal');
  const [revealCustom, setRevealCustom] = useState('');
  // 'match' = inherit commit rate (selectedRevealFeeRate=null); other modes set explicit budget
  const [revealMode, setRevealMode] = useState<FeeMode | 'match'>('match');
  const [loadingFees, setLoadingFees] = useState(false);
  const [feeError, setFeeError] = useState<string | null>(null);

  const MIN_FEE_RATE = 1;
  const MAX_FEE_RATE = 2000;
  const isQuick = detectedMode === 'quick';

  useEffect(() => {
    loadFees();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sync commit rate
  useEffect(() => {
    if (!feeRates) return;
    if (commitMode === 'economy') setSelectedFeeRate(feeRates.economyFee);
    else if (commitMode === 'normal') setSelectedFeeRate(feeRates.halfHourFee);
    else if (commitMode === 'fast') setSelectedFeeRate(feeRates.fastestFee);
    else if (commitMode === 'custom') {
      const v = parseInt(commitCustom, 10);
      if (!isNaN(v) && v > 0) setSelectedFeeRate(Math.min(Math.max(v, MIN_FEE_RATE), MAX_FEE_RATE));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [commitMode, feeRates, commitCustom]);

  // Sync reveal budget. 'match' keeps it null → commit.ts falls back to commitFeeRate.
  useEffect(() => {
    if (revealMode === 'match') { setSelectedRevealFeeRate(null); return; }
    if (!feeRates) return;
    if (revealMode === 'economy') setSelectedRevealFeeRate(feeRates.economyFee);
    else if (revealMode === 'normal') setSelectedRevealFeeRate(feeRates.halfHourFee);
    else if (revealMode === 'fast') setSelectedRevealFeeRate(feeRates.fastestFee);
    else if (revealMode === 'custom') {
      const v = parseInt(revealCustom, 10);
      if (!isNaN(v) && v > 0) setSelectedRevealFeeRate(Math.min(Math.max(v, MIN_FEE_RATE), MAX_FEE_RATE));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealMode, feeRates, revealCustom]);

  async function loadFees() {
    setLoadingFees(true);
    setFeeError(null);
    try {
      const rates = await fetchFeeRates();
      setFeeRates(rates);
    } catch (err) {
      setFeeError(err instanceof Error ? err.message : 'Failed to fetch fee rates');
    } finally {
      setLoadingFees(false);
    }
  }

  function btnClass<M>(current: M, target: M): string {
    const selected = current === target;
    return `flex-1 rounded-lg border px-3 py-2 text-xs font-semibold transition-colors ${
      selected
        ? 'border-orange-500 bg-orange-500/10 text-orange-400'
        : 'border-gray-700 bg-gray-900 text-gray-400 hover:border-gray-600 hover:text-white'
    }`;
  }

  const effectiveReveal = selectedRevealFeeRate ?? selectedFeeRate;
  const badge = isQuick
    ? `${selectedFeeRate} sat/vB`
    : selectedRevealFeeRate && selectedRevealFeeRate !== selectedFeeRate
      ? `commit ${selectedFeeRate} · reveal ≤${selectedRevealFeeRate} sat/vB`
      : `${selectedFeeRate} sat/vB`;

  return (
    <SectionWrapper sectionKey="fee-rate" title="Fee Rates" badge={badge}>
      <div className="flex flex-col gap-6">
        <div className="flex items-center justify-between">
          <p className="text-xs text-gray-500">
            {isQuick
              ? 'Single-TX etch — one fee rate.'
              : 'Commit and reveal can use different rates. Reveal budget pre-funds commit.vout[0] for the max reveal rate.'}
          </p>
          <button
            onClick={loadFees}
            disabled={loadingFees}
            className="text-xs text-gray-500 hover:text-gray-300 disabled:opacity-40 transition-colors"
          >
            {loadingFees ? 'Loading…' : 'Refresh'}
          </button>
        </div>

        {feeError && (
          <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-xs text-red-400">
            {feeError}
          </div>
        )}

        {/* --- Commit (or single TX in quick mode) --- */}
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-gray-300">
              {isQuick ? 'Fee rate' : 'Commit fee rate'}
            </span>
            <span className="font-mono text-xs text-orange-400">{selectedFeeRate} sat/vB</span>
          </div>
          <div className="flex gap-2">
            <button className={btnClass(commitMode, 'economy')} onClick={() => setCommitMode('economy')}>
              <div>Economy</div>
              {feeRates && <div className="text-xs font-mono opacity-70 mt-0.5">{feeRates.economyFee}</div>}
            </button>
            <button className={btnClass(commitMode, 'normal')} onClick={() => setCommitMode('normal')}>
              <div>Normal</div>
              {feeRates && <div className="text-xs font-mono opacity-70 mt-0.5">{feeRates.halfHourFee}</div>}
            </button>
            <button className={btnClass(commitMode, 'fast')} onClick={() => setCommitMode('fast')}>
              <div>Fast</div>
              {feeRates && <div className="text-xs font-mono opacity-70 mt-0.5">{feeRates.fastestFee}</div>}
            </button>
          </div>
          <div className="flex items-center gap-3 mt-1">
            <input
              type="number"
              min={1}
              value={commitCustom}
              onChange={(e) => { setCommitCustom(e.target.value); setCommitMode('custom'); }}
              onFocus={() => setCommitMode('custom')}
              placeholder="Custom sat/vB"
              className={`flex-1 rounded-lg border px-4 py-2 font-mono text-sm text-white placeholder-gray-600 bg-gray-900 focus:outline-none transition-colors ${
                commitMode === 'custom' ? 'border-orange-500' : 'border-gray-700'
              }`}
            />
            <span className="text-xs text-gray-500 shrink-0">sat/vB</span>
          </div>
        </div>

        {/* --- Reveal budget (commit-reveal modes only) --- */}
        {!isQuick && (
          <div className="flex flex-col gap-2 border-t border-gray-800 pt-4">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-gray-300">Reveal fee budget (max)</span>
              <span className="font-mono text-xs text-orange-400">≤{effectiveReveal} sat/vB</span>
            </div>
            <p className="text-xs text-gray-500">
              Pre-funds commit.vout[0] for up to this reveal rate. At reveal sign time, pick any rate from 1 up to this budget; the difference returns to your payment address (segwit) as change.
            </p>
            <div className="flex gap-2">
              <button className={btnClass(revealMode, 'match')} onClick={() => setRevealMode('match')}>
                Match commit
              </button>
              <button className={btnClass(revealMode, 'normal')} onClick={() => setRevealMode('normal')}>
                <div>Normal</div>
                {feeRates && <div className="text-xs font-mono opacity-70 mt-0.5">{feeRates.halfHourFee}</div>}
              </button>
              <button className={btnClass(revealMode, 'fast')} onClick={() => setRevealMode('fast')}>
                <div>Fast</div>
                {feeRates && <div className="text-xs font-mono opacity-70 mt-0.5">{feeRates.fastestFee}</div>}
              </button>
            </div>
            <div className="flex items-center gap-3 mt-1">
              <input
                type="number"
                min={1}
                value={revealCustom}
                onChange={(e) => { setRevealCustom(e.target.value); setRevealMode('custom'); }}
                onFocus={() => setRevealMode('custom')}
                placeholder="Custom sat/vB"
                className={`flex-1 rounded-lg border px-4 py-2 font-mono text-sm text-white placeholder-gray-600 bg-gray-900 focus:outline-none transition-colors ${
                  revealMode === 'custom' ? 'border-orange-500' : 'border-gray-700'
                }`}
              />
              <span className="text-xs text-gray-500 shrink-0">sat/vB</span>
            </div>
            {selectedRevealFeeRate && selectedRevealFeeRate > selectedFeeRate * 3 && (
              <p className="text-xs text-yellow-400 mt-1">
                Note: reveal budget is much higher than commit rate. Unused sats return to your segwit if you reveal at a lower rate.
              </p>
            )}
          </div>
        )}
      </div>
    </SectionWrapper>
  );
}

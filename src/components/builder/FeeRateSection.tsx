'use client';

import { useEffect, useState } from 'react';
import { useBuilderStore } from '@/store/builderStore';
import { fetchFeeRates } from '@/lib/api/mempool';
import SectionWrapper from './SectionWrapper';

export default function FeeRateSection() {
  const feeRates = useBuilderStore((s) => s.feeRates);
  const setFeeRates = useBuilderStore((s) => s.setFeeRates);
  const selectedFeeRate = useBuilderStore((s) => s.selectedFeeRate);
  const setSelectedFeeRate = useBuilderStore((s) => s.setSelectedFeeRate);

  const [customRate, setCustomRate] = useState('');
  const [feeMode, setFeeMode] = useState<'economy' | 'normal' | 'fast' | 'custom'>('normal');
  const [loadingFees, setLoadingFees] = useState(false);
  const [feeError, setFeeError] = useState<string | null>(null);

  const MIN_FEE_RATE = 2;
  const MAX_FEE_RATE = 2000;

  useEffect(() => {
    loadFees();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sync selected fee rate whenever feeMode or feeRates change
  useEffect(() => {
    if (!feeRates) return;
    if (feeMode === 'economy') setSelectedFeeRate(feeRates.economyFee);
    else if (feeMode === 'normal') setSelectedFeeRate(feeRates.halfHourFee);
    else if (feeMode === 'fast') setSelectedFeeRate(feeRates.fastestFee);
    else if (feeMode === 'custom') {
      const v = parseInt(customRate, 10);
      if (!isNaN(v) && v > 0) setSelectedFeeRate(v);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [feeMode, feeRates, customRate]);

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

  function handleCustomRate(val: string) {
    setCustomRate(val);
    setFeeMode('custom');
    const v = parseInt(val, 10);
    if (!isNaN(v) && v >= MIN_FEE_RATE) setSelectedFeeRate(Math.min(v, MAX_FEE_RATE));
  }

  const feeButtonClass = (mode: typeof feeMode) =>
    `flex-1 rounded-lg border px-3 py-2.5 text-sm font-semibold transition-colors ${
      feeMode === mode
        ? 'border-orange-500 bg-orange-500/10 text-orange-400'
        : 'border-gray-700 bg-gray-900 text-gray-400 hover:border-gray-600 hover:text-white'
    }`;

  const badge = `${selectedFeeRate} sat/vB`;

  return (
    <SectionWrapper sectionKey="fee-rate" title="Fee Rate" badge={badge}>
      <div className="flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <p className="text-xs text-gray-500">Select a fee rate for your transaction.</p>
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

        <div className="flex gap-2">
          <button
            className={feeButtonClass('economy')}
            onClick={() => setFeeMode('economy')}
          >
            <div>Economy</div>
            {feeRates && (
              <div className="text-xs font-mono opacity-70 mt-0.5">{feeRates.economyFee} sat/vB</div>
            )}
          </button>
          <button
            className={feeButtonClass('normal')}
            onClick={() => setFeeMode('normal')}
          >
            <div>Normal</div>
            {feeRates && (
              <div className="text-xs font-mono opacity-70 mt-0.5">{feeRates.halfHourFee} sat/vB</div>
            )}
          </button>
          <button
            className={feeButtonClass('fast')}
            onClick={() => setFeeMode('fast')}
          >
            <div>Fast</div>
            {feeRates && (
              <div className="text-xs font-mono opacity-70 mt-0.5">{feeRates.fastestFee} sat/vB</div>
            )}
          </button>
        </div>

        {/* Custom input */}
        <div className="flex items-center gap-3">
          <input
            type="number"
            min={1}
            value={customRate}
            onChange={(e) => handleCustomRate(e.target.value)}
            onFocus={() => setFeeMode('custom')}
            placeholder="Custom sat/vB"
            className={`flex-1 rounded-lg border px-4 py-2.5 font-mono text-sm text-white placeholder-gray-600 bg-gray-900 focus:outline-none transition-colors ${
              feeMode === 'custom' ? 'border-orange-500' : 'border-gray-700'
            }`}
          />
          <span className="text-sm text-gray-500 shrink-0">sat/vB</span>
        </div>

        {/* Selected rate summary */}
        <div className="flex items-center justify-between rounded-lg border border-gray-800 bg-gray-900 px-4 py-3">
          <span className="text-sm text-gray-400">Selected rate</span>
          <span className="font-mono text-sm text-white font-semibold">{selectedFeeRate} sat/vB</span>
        </div>
      </div>
    </SectionWrapper>
  );
}

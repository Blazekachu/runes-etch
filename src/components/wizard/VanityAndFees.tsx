'use client';

import { useEffect, useState } from 'react';
import { useEtchStore } from '@/store/etchStore';
import { fetchFeeRates } from '@/lib/api/mempool';
import { VanityGrinder } from '@/lib/vanity/grinder';

export default function VanityAndFees({ onNext, onBack }: { onNext?: () => void; onBack?: () => void }) {
  const vanityConfig = useEtchStore((s) => s.vanityConfig);
  const setVanityConfig = useEtchStore((s) => s.setVanityConfig);
  const feeRates = useEtchStore((s) => s.feeRates);
  const setFeeRates = useEtchStore((s) => s.setFeeRates);
  const selectedFeeRate = useEtchStore((s) => s.selectedFeeRate);
  const setSelectedFeeRate = useEtchStore((s) => s.setSelectedFeeRate);

  // L8: Re-sanitize hydrated values in case localStorage was corrupted
  const [prefix, setPrefix] = useState(vanityConfig.prefix.replace(/[^0-9a-f]/g, '').slice(0, 6));
  const [suffix, setSuffix] = useState(vanityConfig.suffix.replace(/[^0-9a-f]/g, '').slice(0, 6));
  const [customRate, setCustomRate] = useState('');
  const [feeMode, setFeeMode] = useState<'economy' | 'normal' | 'fast' | 'custom'>('normal');
  const [loadingFees, setLoadingFees] = useState(false);
  const [feeError, setFeeError] = useState<string | null>(null);
  const [highFeeConfirm, setHighFeeConfirm] = useState(false);

  const MAX_VANITY_TOTAL = 6;

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

  function handlePrefix(val: string) {
    const clean = val.toLowerCase().replace(/[^0-9a-f]/g, '');
    const maxLen = MAX_VANITY_TOTAL - suffix.length;
    setPrefix(clean.slice(0, Math.max(0, maxLen)));
  }

  function handleSuffix(val: string) {
    const clean = val.toLowerCase().replace(/[^0-9a-f]/g, '');
    const maxLen = MAX_VANITY_TOTAL - prefix.length;
    setSuffix(clean.slice(0, Math.max(0, maxLen)));
  }

  const MIN_FEE_RATE = 2;
  const MAX_FEE_RATE = 2000;
  const HIGH_FEE_WARNING = 500;

  function handleCustomRate(val: string) {
    setCustomRate(val);
    setFeeMode('custom');
    const v = parseInt(val, 10);
    if (!isNaN(v) && v >= MIN_FEE_RATE) setSelectedFeeRate(Math.min(v, MAX_FEE_RATE));
  }

  function handleContinue() {
    if (selectedFeeRate > HIGH_FEE_WARNING && !highFeeConfirm) {
      setHighFeeConfirm(true);
      return;
    }
    setHighFeeConfirm(false);
    setVanityConfig({ prefix, suffix });
    onNext?.();
  }

  const totalVanityChars = prefix.length + suffix.length;
  const difficulty = VanityGrinder.estimateDifficulty(prefix, suffix);
  const hasVanity = totalVanityChars > 0;
  const previewMiddle = 'xxxxx';
  const previewTxid = `${prefix}${previewMiddle}${suffix}`;

  const feeButtonClass = (mode: typeof feeMode) =>
    `flex-1 rounded-lg border px-3 py-2.5 text-sm font-semibold transition-colors ${
      feeMode === mode
        ? 'border-orange-500 bg-orange-500/10 text-orange-400'
        : 'border-gray-700 bg-gray-900 text-gray-400 hover:border-gray-600 hover:text-white'
    }`;

  return (
    <div className="flex flex-col gap-8 py-8 max-w-xl mx-auto w-full">
      <div>
        <h2 className="text-2xl font-bold text-white mb-1">Vanity & Fees</h2>
        <p className="text-gray-400 text-sm">Optionally grind a vanity TXID and set your fee rate.</p>
      </div>

      {/* Vanity */}
      <div className="flex flex-col gap-4 rounded-lg border border-gray-800 bg-gray-900 p-4">
        <div>
          <p className="text-sm font-medium text-gray-300">Vanity TXID <span className="text-gray-500 font-normal">(optional)</span></p>
          <p className="text-xs text-gray-500 mt-1">
            Allowed characters: <span className="font-mono text-gray-400">0-9 a-f</span> (hex only).
            Max <span className="text-gray-400">{MAX_VANITY_TOTAL}</span> characters total across prefix + suffix.
          </p>
        </div>

        <div className="flex gap-4">
          <div className="flex flex-col gap-1 flex-1">
            <label className="text-xs text-gray-500 uppercase tracking-wider">
              Prefix <span className="normal-case text-gray-600">({prefix.length}/{MAX_VANITY_TOTAL - suffix.length})</span>
            </label>
            <input
              type="text"
              value={prefix}
              onChange={(e) => handlePrefix(e.target.value)}
              placeholder="dead"
              spellCheck={false}
              className="rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 font-mono text-sm text-white placeholder-gray-700 focus:border-orange-500 focus:outline-none"
            />
          </div>
          <div className="flex flex-col gap-1 flex-1">
            <label className="text-xs text-gray-500 uppercase tracking-wider">
              Suffix <span className="normal-case text-gray-600">({suffix.length}/{MAX_VANITY_TOTAL - prefix.length})</span>
            </label>
            <input
              type="text"
              value={suffix}
              onChange={(e) => handleSuffix(e.target.value)}
              placeholder="cafe"
              spellCheck={false}
              className="rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 font-mono text-sm text-white placeholder-gray-700 focus:border-orange-500 focus:outline-none"
            />
          </div>
        </div>

        {/* Character budget */}
        {hasVanity && (
          <div className="flex items-center justify-between text-xs">
            <span className="text-gray-500">Characters used</span>
            <span className={`font-mono font-medium ${totalVanityChars >= MAX_VANITY_TOTAL ? 'text-orange-400' : 'text-gray-300'}`}>
              {totalVanityChars} / {MAX_VANITY_TOTAL}
            </span>
          </div>
        )}

        {/* Preview */}
        <div className="rounded-lg border border-gray-800 bg-gray-950 px-4 py-3">
          <p className="text-xs text-gray-500 mb-1">TXID Preview</p>
          <p className="font-mono text-sm break-all">
            {prefix.length > 0 && (
              <span className="text-orange-400">{prefix}</span>
            )}
            <span className="text-gray-600">{previewMiddle}…</span>
            {suffix.length > 0 && (
              <span className="text-orange-400">{suffix}</span>
            )}
            {!hasVanity && (
              <span className="text-gray-600">any txid</span>
            )}
          </p>
        </div>

        {/* Difficulty */}
        {hasVanity && (
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between text-xs">
              <span className="text-gray-500">Difficulty</span>
              <span className={`font-medium ${
                totalVanityChars <= 3
                  ? 'text-green-400'
                  : totalVanityChars <= 5
                  ? 'text-yellow-400'
                  : 'text-red-400'
              }`}>
                {difficulty.description}
              </span>
            </div>
            <p className="text-xs text-gray-600 font-mono">
              ~{difficulty.avgAttempts.toLocaleString()} avg attempts
            </p>
            {totalVanityChars >= 5 && (
              <p className="text-xs text-yellow-400">
                {totalVanityChars >= 6
                  ? 'This may take several minutes. The grinder uses 4 bytes (nLockTime), so 6 chars is near the practical limit.'
                  : '5 characters will take some time. Consider fewer characters for faster results.'}
              </p>
            )}
          </div>
        )}
      </div>

      {/* Fee rates */}
      <div className="flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <p className="text-sm font-medium text-gray-300">Fee Rate</p>
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

      {highFeeConfirm && (
        <div className="rounded-lg border border-yellow-500/30 bg-yellow-500/10 px-4 py-3 flex flex-col gap-2">
          <p className="text-sm text-yellow-400">
            Fee rate is {selectedFeeRate} sat/vB which is very high. Are you sure?
          </p>
          <div className="flex gap-2">
            <button
              onClick={() => setHighFeeConfirm(false)}
              className="rounded-lg border border-gray-600 px-4 py-1.5 text-xs text-gray-300 hover:border-gray-400 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleContinue}
              className="rounded-lg bg-yellow-600 hover:bg-yellow-500 px-4 py-1.5 text-xs font-semibold text-white transition-colors"
            >
              Yes, Continue
            </button>
          </div>
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
          onClick={handleContinue}
          className="flex-1 rounded-lg bg-orange-500 hover:bg-orange-400 active:bg-orange-600 px-6 py-2.5 font-semibold text-white transition-colors"
        >
          Continue
        </button>
      </div>
    </div>
  );
}

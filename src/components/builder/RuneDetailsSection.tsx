'use client';

import { useState, useEffect } from 'react';
import { useBuilderStore } from '@/store/builderStore';
import { validateRuneName, spacerBitmask } from '@/lib/runes/names';
import { checkRuneNameAvailable } from '@/lib/api/ordinals';
import { getCurrentBlockHeight } from '@/lib/api/mempool';
import SectionWrapper from './SectionWrapper';

export default function RuneDetailsSection() {
  const etching = useBuilderStore((s) => s.etching);
  const updateEtching = useBuilderStore((s) => s.updateEtching);
  const setCurrentBlockHeight = useBuilderStore((s) => s.setCurrentBlockHeight);
  const wallet = useBuilderStore((s) => s.wallet);
  const isTestnet =
    wallet.taprootAddress.startsWith('tb1') ||
    wallet.paymentAddress.startsWith('tb1');

  // Local form state
  const [runeName, setRuneName] = useState(etching.runeName);
  const [symbol, setSymbol] = useState(etching.symbol);
  const [divisibility, setDivisibility] = useState(etching.divisibility);

  // Spacer positions: array of indices (0 = between char[0] and char[1])
  const [spacerPositions, setSpacerPositions] = useState<number[]>(() => {
    const positions: number[] = [];
    let mask = etching.spacers;
    let bit = 0;
    while (mask > 0) {
      if (mask & 1) positions.push(bit);
      mask >>= 1;
      bit++;
    }
    return positions;
  });

  const [blockHeight, setBlockHeight] = useState<number>(0);
  const [checking, setChecking] = useState(false);
  const [availability, setAvailability] = useState<'available' | 'taken' | 'error' | null>(null);
  const [availabilityMsg, setAvailabilityMsg] = useState('');
  const [nameError, setNameError] = useState('');

  // Fetch block height on mount
  useEffect(() => {
    let cancelled = false;
    getCurrentBlockHeight()
      .then((h) => {
        if (!cancelled) {
          setBlockHeight(h);
          setCurrentBlockHeight(h);
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // Sync to store on every relevant change
  useEffect(() => {
    const mask =
      spacerPositions.length > 0 && runeName.length > 1
        ? spacerBitmask(runeName, spacerPositions)
        : 0;
    updateEtching({ runeName, spacers: mask, symbol, divisibility });
  }, [runeName, symbol, divisibility, spacerPositions]);

  function handleNameChange(raw: string) {
    const upper = raw.toUpperCase().replace(/[^A-Z]/g, '');
    setRuneName(upper);
    setAvailability(null);
    setAvailabilityMsg('');
    setSpacerPositions((prev) => prev.filter((p) => p < upper.length - 1));
    const validation = validateRuneName(upper, blockHeight, isTestnet);
    setNameError(validation.valid ? '' : validation.error);
  }

  async function handleCheck() {
    const validation = validateRuneName(runeName, blockHeight, isTestnet);
    if (!validation.valid) {
      setNameError(validation.error);
      return;
    }
    setChecking(true);
    setAvailability(null);
    try {
      const available = await checkRuneNameAvailable(runeName);
      setAvailability(available ? 'available' : 'taken');
      setAvailabilityMsg(available ? 'Name is available!' : 'Name is already taken.');
    } catch {
      setAvailability('error');
      setAvailabilityMsg('Could not check availability. Try again.');
    } finally {
      setChecking(false);
    }
  }

  function toggleSpacer(pos: number) {
    setSpacerPositions((prev) =>
      prev.includes(pos) ? prev.filter((p) => p !== pos) : [...prev, pos]
    );
  }

  function handleSymbolChange(raw: string) {
    const chars = [...raw];
    setSymbol(chars.length > 0 ? chars[chars.length - 1] : '');
  }

  function handleDivisibilityChange(raw: string) {
    const n = parseInt(raw, 10);
    if (isNaN(n)) { setDivisibility(0); return; }
    setDivisibility(Math.min(38, Math.max(0, n)));
  }

  const letters = [...runeName];

  return (
    <SectionWrapper
      sectionKey="rune-details"
      title="Rune Details"
      badge={runeName || undefined}
      required
      error={!runeName || !!nameError}
    >
      <div className="flex flex-col gap-6">

        {/* Rune name */}
        <div className="flex flex-col gap-2">
          <label className="text-sm font-medium text-gray-300">Rune Name</label>
          <div className="flex gap-2">
            <input
              type="text"
              value={runeName}
              onChange={(e) => handleNameChange(e.target.value)}
              placeholder="MYRUNETOKEN"
              className="flex-1 rounded-lg border border-gray-700 bg-gray-900 px-4 py-2.5 font-mono text-white placeholder-gray-600 focus:border-orange-500 focus:outline-none uppercase"
              spellCheck={false}
            />
            <button
              onClick={handleCheck}
              disabled={checking || !runeName || !!nameError}
              className="rounded-lg border border-orange-500 px-4 py-2.5 text-sm font-semibold text-orange-500 hover:bg-orange-500 hover:text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {checking ? 'Checking…' : 'Check'}
            </button>
          </div>
          {nameError && <p className="text-xs text-red-400">{nameError}</p>}
          {availability === 'available' && <p className="text-xs text-green-400">{availabilityMsg}</p>}
          {availability === 'taken' && <p className="text-xs text-red-400">{availabilityMsg}</p>}
          {availability === 'error' && <p className="text-xs text-yellow-400">{availabilityMsg}</p>}
        </div>

        {/* Interactive spacer placement */}
        {letters.length >= 2 && (
          <div className="flex flex-col gap-2">
            <label className="text-sm font-medium text-gray-300">
              Spacers <span className="text-gray-500 font-normal">(click between letters to toggle •)</span>
            </label>
            <div className="flex flex-wrap items-center gap-0 rounded-lg border border-gray-700 bg-gray-900 px-4 py-3">
              {letters.map((ch, i) => (
                <span key={i} className="flex items-center">
                  <span className="font-mono text-lg text-white">{ch}</span>
                  {i < letters.length - 1 && (
                    <button
                      onClick={() => toggleSpacer(i)}
                      className={`w-6 h-6 flex items-center justify-center text-sm rounded transition-colors mx-0.5 ${
                        spacerPositions.includes(i)
                          ? 'text-orange-400 hover:text-orange-300'
                          : 'text-gray-700 hover:text-gray-400'
                      }`}
                      title={spacerPositions.includes(i) ? 'Remove spacer' : 'Add spacer'}
                    >
                      •
                    </button>
                  )}
                </span>
              ))}
            </div>
            {spacerPositions.length > 0 && (
              <p className="text-xs text-gray-500 font-mono">
                Preview: {letters.map((ch, i) => ch + (spacerPositions.includes(i) ? '•' : '')).join('')}
              </p>
            )}
          </div>
        )}

        {/* Symbol */}
        <div className="flex flex-col gap-2">
          <label className="text-sm font-medium text-gray-300">
            Symbol <span className="text-gray-500 font-normal">(single unicode character)</span>
          </label>
          <input
            type="text"
            value={symbol}
            onChange={(e) => handleSymbolChange(e.target.value)}
            placeholder="¤"
            className="w-24 rounded-lg border border-gray-700 bg-gray-900 px-4 py-2.5 font-mono text-white placeholder-gray-600 focus:border-orange-500 focus:outline-none text-center text-lg"
          />
          <p className="text-xs text-gray-500">
            Any Unicode character — letters, emoji, symbols. Examples:{' '}
            <span className="font-mono">$ ¤ ⧉ 🔥 ∞ ₿</span>
          </p>
        </div>

        {/* Divisibility */}
        <div className="flex flex-col gap-2">
          <label className="text-sm font-medium text-gray-300">
            Divisibility <span className="text-gray-500 font-normal">(0–38 decimal places)</span>
          </label>
          <input
            type="number"
            min={0}
            max={38}
            value={divisibility}
            onChange={(e) => handleDivisibilityChange(e.target.value)}
            className="w-32 rounded-lg border border-gray-700 bg-gray-900 px-4 py-2.5 font-mono text-white focus:border-orange-500 focus:outline-none"
          />
        </div>

      </div>
    </SectionWrapper>
  );
}

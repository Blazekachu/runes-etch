'use client';

import { useState, useEffect } from 'react';
import { useBuilderStore } from '@/store/builderStore';
import { validateRuneName, spacerBitmask } from '@/lib/runes/names';
import { getRuneNameStatus, getRuneMinimumFromOrd } from '@/lib/api/ordinals';
import { getCurrentBlockHeight } from '@/lib/api/mempool';
import SectionWrapper from './SectionWrapper';

export default function RuneDetailsSection() {
  const etching = useBuilderStore((s) => s.etching);
  const updateEtching = useBuilderStore((s) => s.updateEtching);
  const setCurrentBlockHeight = useBuilderStore((s) => s.setCurrentBlockHeight);
  const runeMinimum = useBuilderStore((s) => s.runeMinimum);
  const setRuneMinimum = useBuilderStore((s) => s.setRuneMinimum);
  const wallet = useBuilderStore((s) => s.wallet);
  const phase = useBuilderStore((s) => s.phase);
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
  const [heightError, setHeightError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [availability, setAvailability] = useState<'available' | 'taken' | 'unknown' | 'error' | null>(null);
  const [availabilityMsg, setAvailabilityMsg] = useState('');
  const [nameError, setNameError] = useState('');
  /** Projected block height at which a below-minimum name will unlock for
   *  quick-etch. Set by validateRuneName when name is below the chain's
   *  current minimum. Used to advise the user when to broadcast the reveal
   *  if they commit now. (Finding #15) */
  const [nameUnlockHeight, setNameUnlockHeight] = useState<number | null>(null);

  // Fetch block height on mount AND whenever the wallet network changes — mainnet
  // and testnet have very different tips, so a network switch in-session would
  // otherwise apply a stale height to validation.
  async function loadBlockHeight() {
    setHeightError(null);
    try {
      const h = await getCurrentBlockHeight();
      setBlockHeight(h);
      setCurrentBlockHeight(h);
    } catch (err) {
      // Surface failure instead of swallowing — left as 0 silently produced
      // misleading "minimum is 13 letters" errors in validateRuneName.
      setHeightError(err instanceof Error ? err.message : 'Failed to fetch chain tip');
    }
  }
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (cancelled) return;
      await loadBlockHeight();
      // #11: fetch the chain's authoritative rune-name minimum so quick-etch
      // can reject below-minimum names on testnet4 (and any chain) before
      // broadcasting a TX that ord would silently cenotaph.
      if (cancelled) return;
      const min = await getRuneMinimumFromOrd();
      if (cancelled) return;
      setRuneMinimum(min);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wallet.taprootAddress]);

  // Re-validate the rune name when block height OR ord's minimum arrives or
  // changes. Without these deps the keystroke-time validation would persist
  // with a stale (often zero) height and the user sees a misleading "loading"
  // error even after the fetch completes; without runeMinimum we'd miss the
  // moment the testnet4 minimum lands and a previously-permissive name
  // suddenly becomes below-minimum.
  useEffect(() => {
    if (!runeName) { setNameError(''); setNameUnlockHeight(null); return; }
    const v = validateRuneName(runeName, blockHeight, isTestnet, runeMinimum);
    if (v.valid) {
      setNameError('');
      setNameUnlockHeight(null);
    } else {
      setNameError(v.error);
      setNameUnlockHeight(v.unlockHeight ?? null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blockHeight, isTestnet, runeMinimum]);

  // Sync local input state FROM store when store changes externally (bundle load, reset).
  // Without these, useState's initial-value-only behavior would leave inputs at defaults
  // showing placeholders even though the store has real bundle data.
  useEffect(() => { setRuneName(etching.runeName); }, [etching.runeName]);
  useEffect(() => { setSymbol(etching.symbol); }, [etching.symbol]);
  useEffect(() => { setDivisibility(etching.divisibility); }, [etching.divisibility]);
  useEffect(() => {
    const positions: number[] = [];
    let mask = etching.spacers;
    let bit = 0;
    while (mask > 0) {
      if (mask & 1) positions.push(bit);
      mask >>= 1;
      bit++;
    }
    setSpacerPositions(positions);
  }, [etching.spacers]);

  // Sync TO store on user edits. Gated on phase + equality guard.
  // Why: keeping `etching` out of deps prevents sync-back from re-firing every time
  // ANY section writes etching (which creates a new etching ref). The equality guard
  // reads etching via getState() so we still avoid redundant writes.
  useEffect(() => {
    if (phase !== 'building') return;
    const current = useBuilderStore.getState().etching;
    const mask =
      spacerPositions.length > 0 && runeName.length > 1
        ? spacerBitmask(runeName, spacerPositions)
        : 0;
    if (
      runeName === current.runeName &&
      symbol === current.symbol &&
      divisibility === current.divisibility &&
      mask === current.spacers
    ) return;
    updateEtching({ runeName, spacers: mask, symbol, divisibility });
  }, [runeName, symbol, divisibility, spacerPositions, phase, updateEtching]);

  function handleNameChange(raw: string) {
    const upper = raw.toUpperCase().replace(/[^A-Z]/g, '');
    setRuneName(upper);
    setAvailability(null);
    setAvailabilityMsg('');
    setSpacerPositions((prev) => prev.filter((p) => p < upper.length - 1));
    const validation = validateRuneName(upper, blockHeight, isTestnet, runeMinimum);
    if (validation.valid) {
      setNameError('');
      setNameUnlockHeight(null);
    } else {
      setNameError(validation.error);
      setNameUnlockHeight(validation.unlockHeight ?? null);
    }
  }

  async function handleCheck() {
    const validation = validateRuneName(runeName, blockHeight, isTestnet, runeMinimum);
    if (!validation.valid) {
      setNameError(validation.error);
      setNameUnlockHeight(validation.unlockHeight ?? null);
      return;
    }
    setChecking(true);
    setAvailability(null);
    try {
      const status = await getRuneNameStatus(runeName);
      if (status.state === 'available') {
        setAvailability('available');
        setAvailabilityMsg('Name is available!');
      } else if (status.state === 'taken') {
        setAvailability('taken');
        setAvailabilityMsg('Name is already taken.');
      } else {
        setAvailability('unknown');
        if (status.reason === 'indexer-wedged') {
          setAvailabilityMsg(
            `Indexer wedged on a reorg (ord at ${status.indexerHeight}, tip at ${status.chainHeight}, ${status.behind} blocks behind). Name uniqueness cannot be checked from this indexer — verify out-of-band via mempool.space, ordiscan, or ord.net before broadcasting.`
          );
        } else {
          setAvailabilityMsg(
            `Indexer is ${status.behind} blocks behind chain tip (ord at ${status.indexerHeight}, tip at ${status.chainHeight}). Name appears unused but cannot be confirmed — wait for the indexer to catch up before broadcasting.`
          );
        }
      }
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
          {nameError && nameUnlockHeight !== null && blockHeight > 0 && (
            <div className="mt-1 rounded-md border border-yellow-500/30 bg-yellow-500/10 px-3 py-2 text-xs text-yellow-300">
              <p>
                ⏳ This name unlocks at block{' '}
                <span className="font-mono font-semibold">
                  {nameUnlockHeight.toLocaleString()}
                </span>
                {' '}— exactly{' '}
                <span className="font-mono">
                  {Math.max(0, nameUnlockHeight - blockHeight).toLocaleString()}
                </span>
                {' '}blocks past the current tip (
                <span className="font-mono">{blockHeight.toLocaleString()}</span>
                ).
              </p>
              <p className="mt-1">
                If you commit-reveal now, broadcast the reveal at or after that
                block — earlier reveals will cenotaph.{' '}
                <span className="font-semibold">Recommended:</span> after the
                commit confirms, download the bundle (button on the Waiting
                screen) so you can close this tab and resume the etch when the
                name unlocks.
              </p>
            </div>
          )}
          {availability === 'available' && <p className="text-xs text-green-400">{availabilityMsg}</p>}
          {availability === 'taken' && <p className="text-xs text-red-400">{availabilityMsg}</p>}
          {availability === 'unknown' && <p className="text-xs text-yellow-400">⚠ {availabilityMsg}</p>}
          {availability === 'error' && <p className="text-xs text-yellow-400">{availabilityMsg}</p>}
          {heightError && (
            <p className="text-xs text-yellow-400">
              Couldn&apos;t fetch chain tip ({heightError}).{' '}
              <button onClick={loadBlockHeight} className="underline hover:text-yellow-300">Retry</button>
            </p>
          )}
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

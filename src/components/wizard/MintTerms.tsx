'use client';

import { useState } from 'react';
import { useEtchStore } from '@/store/etchStore';

const MAX_U128 = (1n << 128n) - 1n;

function parseBigInt(raw: string): bigint {
  const trimmed = raw.trim();
  if (!trimmed || trimmed === '') return 0n;
  try { return BigInt(trimmed); } catch { return 0n; }
}

function parseOptionalInt(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const n = parseInt(trimmed, 10);
  return isNaN(n) ? null : n;
}

function clampU128(val: bigint): bigint {
  if (val < 0n) return 0n;
  if (val > MAX_U128) return MAX_U128;
  return val;
}

export default function MintTerms({ onNext, onBack }: { onNext?: () => void; onBack?: () => void }) {
  const etching = useEtchStore((s) => s.etching);
  const updateEtching = useEtchStore((s) => s.updateEtching);

  const [premine, setPremine] = useState(etching.premine.toString());
  const [openMint, setOpenMint] = useState(etching.terms !== null);
  const [turbo, setTurbo] = useState(etching.turbo);

  // Mint terms
  const [mintAmount, setMintAmount] = useState(etching.terms?.amount.toString() ?? '0');
  const [cap, setCap] = useState(etching.terms?.cap.toString() ?? '0');
  const [heightStart, setHeightStart] = useState(etching.terms?.heightStart?.toString() ?? '');
  const [heightEnd, setHeightEnd] = useState(etching.terms?.heightEnd?.toString() ?? '');
  const [offsetStart, setOffsetStart] = useState(etching.terms?.offsetStart?.toString() ?? '');
  const [offsetEnd, setOffsetEnd] = useState(etching.terms?.offsetEnd?.toString() ?? '');

  const premineVal = clampU128(parseBigInt(premine));
  const mintAmountVal = clampU128(parseBigInt(mintAmount));
  const capVal = clampU128(parseBigInt(cap));

  // Overflow-safe total supply
  let totalSupply = premineVal;
  let supplyOverflow = false;
  if (openMint && capVal > 0n && mintAmountVal > 0n) {
    const mintTotal = capVal * mintAmountVal;
    if (mintTotal / capVal !== mintAmountVal || mintTotal > MAX_U128) {
      supplyOverflow = true;
      totalSupply = MAX_U128;
    } else {
      const sum = premineVal + mintTotal;
      if (sum < premineVal || sum > MAX_U128) {
        supplyOverflow = true;
        totalSupply = MAX_U128;
      } else {
        totalSupply = sum;
      }
    }
  }

  // Validation warnings
  const warnings: string[] = [];

  if (premineVal > MAX_U128) warnings.push('Premine exceeds u128 maximum and will be clamped.');
  if (openMint && mintAmountVal > MAX_U128) warnings.push('Amount per mint exceeds u128 maximum.');
  if (openMint && capVal > MAX_U128) warnings.push('Mint cap exceeds u128 maximum.');
  if (supplyOverflow) warnings.push('Total supply overflows u128. Reduce premine, amount, or cap.');
  if (openMint && mintAmountVal === 0n && capVal > 0n) warnings.push('Amount per mint is 0 — minters would receive nothing.');
  if (openMint && capVal === 0n && mintAmountVal > 0n) warnings.push('Mint cap is 0 — nobody can mint.');
  if (premineVal === 0n && !openMint) warnings.push('No premine and no open mint — this rune will have zero supply.');

  const hStart = parseOptionalInt(heightStart);
  const hEnd = parseOptionalInt(heightEnd);
  const oStart = parseOptionalInt(offsetStart);
  const oEnd = parseOptionalInt(offsetEnd);

  if (hStart !== null && hEnd !== null && hEnd <= hStart) {
    warnings.push(`Height end (${hEnd}) should be greater than height start (${hStart}).`);
  }
  if (oStart !== null && oEnd !== null && oEnd <= oStart) {
    warnings.push(`Offset end (${oEnd}) should be greater than offset start (${oStart}).`);
  }
  if (hStart !== null && hStart < 840000) {
    warnings.push('Height start is before rune activation (840,000).');
  }

  const hasErrors = supplyOverflow || (openMint && mintAmountVal > MAX_U128) || (openMint && capVal > MAX_U128) || premineVal > MAX_U128;

  function formatBigInt(n: bigint): string {
    return n.toLocaleString();
  }

  function handleContinue() {
    if (hasErrors) return;
    updateEtching({
      premine: premineVal,
      turbo,
      terms: openMint
        ? {
            amount: mintAmountVal,
            cap: capVal,
            heightStart: hStart,
            heightEnd: hEnd,
            offsetStart: oStart,
            offsetEnd: oEnd,
          }
        : null,
    });
    onNext?.();
  }

  return (
    <div className="flex flex-col gap-8 py-8 max-w-xl mx-auto w-full">
      <div>
        <h2 className="text-2xl font-bold text-white mb-1">Mint Terms</h2>
        <p className="text-gray-400 text-sm">Configure supply, premining, and open mint options.</p>
      </div>

      {/* Premine */}
      <div className="flex flex-col gap-2">
        <label className="text-sm font-medium text-gray-300">Premine Amount</label>
        <input
          type="text"
          inputMode="numeric"
          value={premine}
          onChange={(e) => setPremine(e.target.value.replace(/[^0-9]/g, ''))}
          placeholder="0"
          className="rounded-lg border border-gray-700 bg-gray-900 px-4 py-2.5 font-mono text-white placeholder-gray-600 focus:border-orange-500 focus:outline-none"
        />
        <p className="text-xs text-gray-500">Tokens minted directly to your wallet at etching. Max: u128 ({'\u2248'}3.4 × 10³⁸).</p>
      </div>

      {/* Open Mint toggle */}
      <div className="flex items-center justify-between rounded-lg border border-gray-700 bg-gray-900 px-4 py-3">
        <div>
          <p className="text-sm font-medium text-white">Open Mint</p>
          <p className="text-xs text-gray-500 mt-0.5">Allow others to mint tokens from this rune.</p>
        </div>
        <button
          onClick={() => setOpenMint((v) => !v)}
          className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus:outline-none ${
            openMint ? 'bg-orange-500' : 'bg-gray-700'
          }`}
          role="switch"
          aria-checked={openMint}
        >
          <span
            className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition-transform ${
              openMint ? 'translate-x-5' : 'translate-x-0'
            }`}
          />
        </button>
      </div>

      {/* Open mint fields */}
      {openMint && (
        <div className="flex flex-col gap-5 rounded-lg border border-gray-700 bg-gray-900/50 p-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium text-gray-400 uppercase tracking-wider">Amount per mint</label>
              <input
                type="text"
                inputMode="numeric"
                value={mintAmount}
                onChange={(e) => setMintAmount(e.target.value.replace(/[^0-9]/g, ''))}
                placeholder="1000"
                className="rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 font-mono text-sm text-white placeholder-gray-600 focus:border-orange-500 focus:outline-none"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium text-gray-400 uppercase tracking-wider">Mint cap</label>
              <input
                type="text"
                inputMode="numeric"
                value={cap}
                onChange={(e) => setCap(e.target.value.replace(/[^0-9]/g, ''))}
                placeholder="21000"
                className="rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 font-mono text-sm text-white placeholder-gray-600 focus:border-orange-500 focus:outline-none"
              />
            </div>
          </div>

          <div>
            <p className="text-xs font-medium text-gray-400 uppercase tracking-wider mb-2">Block Height Window <span className="normal-case text-gray-600">(optional)</span></p>
            <div className="grid grid-cols-2 gap-4">
              <div className="flex flex-col gap-1.5">
                <label className="text-xs text-gray-500">Start height</label>
                <input
                  type="text" inputMode="numeric" value={heightStart}
                  onChange={(e) => setHeightStart(e.target.value.replace(/[^0-9]/g, ''))}
                  placeholder="e.g. 840000"
                  className="rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 font-mono text-sm text-white placeholder-gray-600 focus:border-orange-500 focus:outline-none"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <label className="text-xs text-gray-500">End height</label>
                <input
                  type="text" inputMode="numeric" value={heightEnd}
                  onChange={(e) => setHeightEnd(e.target.value.replace(/[^0-9]/g, ''))}
                  placeholder="e.g. 1050000"
                  className="rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 font-mono text-sm text-white placeholder-gray-600 focus:border-orange-500 focus:outline-none"
                />
              </div>
            </div>
          </div>

          <div>
            <p className="text-xs font-medium text-gray-400 uppercase tracking-wider mb-2">Block Offset Window <span className="normal-case text-gray-600">(optional, relative to etch block)</span></p>
            <div className="grid grid-cols-2 gap-4">
              <div className="flex flex-col gap-1.5">
                <label className="text-xs text-gray-500">Start offset</label>
                <input
                  type="text" inputMode="numeric" value={offsetStart}
                  onChange={(e) => setOffsetStart(e.target.value.replace(/[^0-9]/g, ''))}
                  placeholder="e.g. 0"
                  className="rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 font-mono text-sm text-white placeholder-gray-600 focus:border-orange-500 focus:outline-none"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <label className="text-xs text-gray-500">End offset</label>
                <input
                  type="text" inputMode="numeric" value={offsetEnd}
                  onChange={(e) => setOffsetEnd(e.target.value.replace(/[^0-9]/g, ''))}
                  placeholder="e.g. 144"
                  className="rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 font-mono text-sm text-white placeholder-gray-600 focus:border-orange-500 focus:outline-none"
                />
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Turbo flag */}
      <div className="flex items-center justify-between rounded-lg border border-gray-700 bg-gray-900 px-4 py-3">
        <div>
          <p className="text-sm font-medium text-white">Turbo</p>
          <p className="text-xs text-gray-500 mt-0.5">Opt into future ord protocol upgrades for this rune. Recommended — most runes enable it.</p>
        </div>
        <button
          onClick={() => setTurbo((v) => !v)}
          className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus:outline-none ${
            turbo ? 'bg-orange-500' : 'bg-gray-700'
          }`}
          role="switch"
          aria-checked={turbo}
        >
          <span
            className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition-transform ${
              turbo ? 'translate-x-5' : 'translate-x-0'
            }`}
          />
        </button>
      </div>

      {/* Warnings */}
      {warnings.length > 0 && (
        <div className="rounded-lg border border-yellow-500/30 bg-yellow-500/10 px-4 py-3 flex flex-col gap-1.5">
          {warnings.map((w, i) => (
            <p key={i} className={`text-xs ${hasErrors ? 'text-red-400' : 'text-yellow-400'}`}>{w}</p>
          ))}
        </div>
      )}

      {/* Live total supply */}
      <div className="rounded-lg border border-orange-500/20 bg-orange-500/5 px-4 py-3 flex items-center justify-between">
        <span className="text-sm text-gray-400">Total Supply</span>
        <span className="font-mono text-orange-400 font-semibold">
          {supplyOverflow ? (
            <span className="text-red-400">OVERFLOW</span>
          ) : (
            <>
              {formatBigInt(totalSupply)}
              {openMint && capVal > 0n && mintAmountVal > 0n && (
                <span className="text-xs text-gray-500 font-normal ml-2">
                  ({formatBigInt(premineVal)} premine + {formatBigInt(capVal)} × {formatBigInt(mintAmountVal)})
                </span>
              )}
            </>
          )}
        </span>
      </div>

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
          disabled={hasErrors}
          className="flex-1 rounded-lg bg-orange-500 hover:bg-orange-400 active:bg-orange-600 disabled:opacity-40 disabled:cursor-not-allowed px-6 py-2.5 font-semibold text-white transition-colors"
        >
          Continue
        </button>
      </div>
    </div>
  );
}

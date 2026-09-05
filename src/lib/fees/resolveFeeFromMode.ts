import type { FeeRates } from '@/types';

export type FeeMode = 'economy' | 'normal' | 'fast' | 'custom';
export type RevealFeeMode = FeeMode | 'match';

export type FeeResolution =
  | { kind: 'set'; value: number }
  | { kind: 'match' }
  | { kind: 'noop' };

/** Minimum custom sat/vB (2 decimal places). Sub-1 rates are valid when the mempool allows. */
export const MIN_FEE_RATE = 0.01;
export const MAX_FEE_RATE = 2000;

/** Parse/normalize a user fee-rate string to at most 2 decimal places. */
export function parseFeeRateInput(customInput: string): number | null {
  const trimmed = customInput.trim();
  if (!trimmed) return null;
  const v = Number(trimmed);
  if (!Number.isFinite(v) || v < MIN_FEE_RATE) return null;
  const rounded = Math.round(v * 100) / 100;
  if (rounded < MIN_FEE_RATE) return null;
  return Math.min(rounded, MAX_FEE_RATE);
}

export function formatFeeRate(rate: number): string {
  if (!Number.isFinite(rate)) return '—';
  const rounded = Math.round(rate * 100) / 100;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2);
}

/**
 * Pure resolver for fee picker UI state → store action.
 *
 * Why this exists: the inline useEffect in FeeRateSection used to early-return
 * on `!feeRates`, which silently no-op'd the custom-input branch (the custom
 * input doesn't need feeRates — it parses the user-typed string). Splitting
 * the resolution out lets us guarantee custom-input always works, regardless
 * of fee-rate fetch state.
 */
export function resolveFeeFromMode(
  mode: RevealFeeMode,
  feeRates: FeeRates | null,
  customInput: string,
): FeeResolution {
  if (mode === 'match') return { kind: 'match' };

  if (mode === 'custom') {
    const v = parseFeeRateInput(customInput);
    if (v === null) return { kind: 'noop' };
    return { kind: 'set', value: v };
  }

  if (!feeRates) return { kind: 'noop' };

  if (mode === 'economy') return { kind: 'set', value: feeRates.economyFee };
  if (mode === 'normal') return { kind: 'set', value: feeRates.halfHourFee };
  if (mode === 'fast') return { kind: 'set', value: feeRates.fastestFee };

  return { kind: 'noop' };
}

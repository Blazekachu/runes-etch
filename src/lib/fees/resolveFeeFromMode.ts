import type { FeeRates } from '@/types';

export type FeeMode = 'economy' | 'normal' | 'fast' | 'custom';
export type RevealFeeMode = FeeMode | 'match';

export type FeeResolution =
  | { kind: 'set'; value: number }
  | { kind: 'match' }
  | { kind: 'noop' };

export const MIN_FEE_RATE = 1;
export const MAX_FEE_RATE = 2000;

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
    const v = parseInt(customInput, 10);
    if (isNaN(v) || v < MIN_FEE_RATE) return { kind: 'noop' };
    return { kind: 'set', value: Math.min(v, MAX_FEE_RATE) };
  }

  if (!feeRates) return { kind: 'noop' };

  if (mode === 'economy') return { kind: 'set', value: feeRates.economyFee };
  if (mode === 'normal') return { kind: 'set', value: feeRates.halfHourFee };
  if (mode === 'fast') return { kind: 'set', value: feeRates.fastestFee };

  return { kind: 'noop' };
}

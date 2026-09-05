/**
 * Bitcoin fees are whole sats. Given a target sat/vB rate (may be fractional),
 * pick the integer fee whose effective rate (fee / vsize) is closest to target.
 *
 * Example: 141 vB @ 0.69 → 141 * 0.69 = 97.29 → 97 sats → ~0.688 sat/vB
 * (cannot hit 0.69 exactly for this size; 98 sats would be ~0.695).
 */
export function feeFromVSize(vbytes: number, feeRateSatPerVb: number): number {
  if (!Number.isFinite(vbytes) || vbytes <= 0) return 0;
  if (!Number.isFinite(feeRateSatPerVb) || feeRateSatPerVb <= 0) return 0;
  return Math.max(0, Math.round(vbytes * feeRateSatPerVb));
}

export function feeFromVSizeBigInt(vbytes: number, feeRateSatPerVb: number): bigint {
  return BigInt(feeFromVSize(vbytes, feeRateSatPerVb));
}

/** Effective rate after integer-sat rounding — for UI honesty. */
export function effectiveFeeRate(vbytes: number, feeSats: number): number {
  if (!Number.isFinite(vbytes) || vbytes <= 0) return 0;
  return Math.round((feeSats / vbytes) * 100) / 100;
}

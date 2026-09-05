import { describe, it, expect } from 'vitest';
import { feeFromVSize, effectiveFeeRate } from '../feeFromVSize';

describe('feeFromVSize', () => {
  it('rounds to nearest sat for fractional rates', () => {
    // 141 * 0.69 = 97.29 → 97
    expect(feeFromVSize(141, 0.69)).toBe(97);
    expect(effectiveFeeRate(141, 97)).toBe(0.69);
  });

  it('hits exact integer products without drift', () => {
    expect(feeFromVSize(200, 1)).toBe(200);
    expect(feeFromVSize(165, 2)).toBe(330);
  });

  it('supports sub-1 and multi-decimal targets', () => {
    expect(feeFromVSize(100, 0.77)).toBe(77);
    expect(feeFromVSize(100, 1.21)).toBe(121);
    expect(feeFromVSize(100, 4.21)).toBe(421);
  });
});

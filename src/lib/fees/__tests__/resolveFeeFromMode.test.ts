import { describe, it, expect } from 'vitest';
import { resolveFeeFromMode } from '../resolveFeeFromMode';
import type { FeeRates } from '@/types';

const rates: FeeRates = {
  fastestFee: 20,
  halfHourFee: 10,
  hourFee: 8,
  economyFee: 2,
  minimumFee: 1,
};

describe('resolveFeeFromMode', () => {
  describe('custom mode survives without feeRates (regression for Finding #5)', () => {
    it('parses a valid custom value when feeRates is null', () => {
      expect(resolveFeeFromMode('custom', null, '5')).toEqual({ kind: 'set', value: 5 });
    });

    it('parses a valid custom value when feeRates is set too', () => {
      expect(resolveFeeFromMode('custom', rates, '7')).toEqual({ kind: 'set', value: 7 });
    });

    it('clamps custom value above MAX_FEE_RATE (2000)', () => {
      expect(resolveFeeFromMode('custom', null, '5000')).toEqual({ kind: 'set', value: 2000 });
    });

    it('clamps custom value below MIN_FEE_RATE (1)', () => {
      expect(resolveFeeFromMode('custom', null, '0')).toEqual({ kind: 'noop' });
    });

    it('noops on empty custom input', () => {
      expect(resolveFeeFromMode('custom', null, '')).toEqual({ kind: 'noop' });
    });

    it('noops on non-numeric custom input', () => {
      expect(resolveFeeFromMode('custom', null, 'abc')).toEqual({ kind: 'noop' });
    });

    it('noops on negative custom input', () => {
      expect(resolveFeeFromMode('custom', null, '-3')).toEqual({ kind: 'noop' });
    });
  });

  describe('preset modes require feeRates', () => {
    it('economy with feeRates picks economyFee', () => {
      expect(resolveFeeFromMode('economy', rates, '')).toEqual({ kind: 'set', value: 2 });
    });

    it('normal with feeRates picks halfHourFee', () => {
      expect(resolveFeeFromMode('normal', rates, '')).toEqual({ kind: 'set', value: 10 });
    });

    it('fast with feeRates picks fastestFee', () => {
      expect(resolveFeeFromMode('fast', rates, '')).toEqual({ kind: 'set', value: 20 });
    });

    it('economy without feeRates is a noop', () => {
      expect(resolveFeeFromMode('economy', null, '')).toEqual({ kind: 'noop' });
    });

    it('normal without feeRates is a noop', () => {
      expect(resolveFeeFromMode('normal', null, '')).toEqual({ kind: 'noop' });
    });

    it('fast without feeRates is a noop', () => {
      expect(resolveFeeFromMode('fast', null, '')).toEqual({ kind: 'noop' });
    });
  });

  describe('match mode (reveal-only)', () => {
    it('match returns {kind: "match"} regardless of feeRates', () => {
      expect(resolveFeeFromMode('match', rates, '')).toEqual({ kind: 'match' });
      expect(resolveFeeFromMode('match', null, '')).toEqual({ kind: 'match' });
    });

    it('match ignores customInput', () => {
      expect(resolveFeeFromMode('match', null, '99')).toEqual({ kind: 'match' });
    });
  });
});

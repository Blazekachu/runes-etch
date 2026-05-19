import { describe, it, expect } from 'vitest';
import {
  runeNameToU128,
  u128ToRuneName,
  spacerBitmask,
  minimumAtHeight,
  minNameLengthAtHeight,
  computeUnlockHeight,
  validateRuneName,
} from '../names';

describe('Rune name encoding', () => {
  describe('runeNameToU128', () => {
    it('encodes "A" as 0', () => {
      expect(runeNameToU128('A')).toBe(0n);
    });
    it('encodes "B" as 1', () => {
      expect(runeNameToU128('B')).toBe(1n);
    });
    it('encodes "Z" as 25', () => {
      expect(runeNameToU128('Z')).toBe(25n);
    });
    it('encodes "AA" as 26', () => {
      expect(runeNameToU128('AA')).toBe(26n);
    });
    it('encodes "AB" as 27', () => {
      expect(runeNameToU128('AB')).toBe(27n);
    });
    it('encodes "AZ" as 51', () => {
      expect(runeNameToU128('AZ')).toBe(51n);
    });
    it('encodes "BA" as 52', () => {
      expect(runeNameToU128('BA')).toBe(52n);
    });
    it('encodes "UNCOMMONGOODS"', () => {
      const value = runeNameToU128('UNCOMMONGOODS');
      expect(value).toBeGreaterThan(0n);
      expect(u128ToRuneName(value)).toBe('UNCOMMONGOODS');
    });
    it('rejects empty string', () => {
      expect(() => runeNameToU128('')).toThrow();
    });
    it('rejects non-uppercase letters', () => {
      expect(() => runeNameToU128('abc')).toThrow();
      expect(() => runeNameToU128('A1B')).toThrow();
    });
  });

  describe('u128ToRuneName', () => {
    it('decodes 0 to "A"', () => {
      expect(u128ToRuneName(0n)).toBe('A');
    });
    it('decodes 25 to "Z"', () => {
      expect(u128ToRuneName(25n)).toBe('Z');
    });
    it('decodes 26 to "AA"', () => {
      expect(u128ToRuneName(26n)).toBe('AA');
    });
    it('round-trips names', () => {
      const names = ['A', 'Z', 'AA', 'AZ', 'BA', 'ZZ', 'AAA', 'BITCOIN', 'UNCOMMONGOODS'];
      for (const name of names) {
        expect(u128ToRuneName(runeNameToU128(name))).toBe(name);
      }
    });
  });

  describe('spacerBitmask', () => {
    it('returns 0 for no spacers', () => {
      expect(spacerBitmask('UNCOMMONGOODS', [])).toBe(0);
    });
    it('sets bit for spacer position', () => {
      expect(spacerBitmask('UNCOMMONGOODS', [7])).toBe(128);
    });
    it('sets multiple bits', () => {
      expect(spacerBitmask('UNCOMMONGOODS', [1, 7])).toBe(130);
    });
  });

  describe('minimumAtHeight (ord-compatible interpolation)', () => {
    it('returns max value before activation', () => {
      const min = minimumAtHeight(839999);
      // Should be STEPS[12] = 13-char boundary
      expect(min).toBeGreaterThan(0n);
      expect(u128ToRuneName(min).length).toBe(13);
    });

    it('returns 0 at end block (1,050,000)', () => {
      expect(minimumAtHeight(1050000)).toBe(0n);
    });

    it('returns 0 after end block', () => {
      expect(minimumAtHeight(1100000)).toBe(0n);
    });

    it('decreases over time', () => {
      const early = minimumAtHeight(850000);
      const later = minimumAtHeight(950000);
      expect(later).toBeLessThan(early);
    });

    it('at block 949303 allows 6-letter names', () => {
      const min = minimumAtHeight(949303);
      const minName = u128ToRuneName(min);
      expect(minName.length).toBe(6);
    });

    it('at activation allows 13-char names', () => {
      const min = minimumAtHeight(840000);
      const minName = u128ToRuneName(min);
      expect(minName.length).toBeLessThanOrEqual(13);
    });

    it('interpolates within a window (not just step boundaries)', () => {
      // At the start of the 7->6 char window (block 945,000)
      const atStart = minimumAtHeight(945000);
      // Midway through
      const atMid = minimumAtHeight(953750);
      // Near end
      const atEnd = minimumAtHeight(962499);

      // All should be 6-char names but decreasing values
      expect(u128ToRuneName(atStart).length).toBeLessThanOrEqual(7);
      expect(atMid).toBeLessThan(atStart);
      expect(atEnd).toBeLessThan(atMid);
    });
  });

  describe('minNameLengthAtHeight', () => {
    it('requires 13+ chars before activation', () => {
      expect(minNameLengthAtHeight(839999)).toBe(13);
    });
    it('allows shorter names at later heights', () => {
      expect(minNameLengthAtHeight(950000)).toBeLessThan(13);
    });
    it('allows 1-char names far in the future', () => {
      expect(minNameLengthAtHeight(1050000)).toBe(1);
    });
    it('returns 6 at block 949303', () => {
      expect(minNameLengthAtHeight(949303)).toBe(6);
    });
  });

  describe('validateRuneName', () => {
    it('accepts valid long names at activation', () => {
      expect(validateRuneName('AAAAAAAAAAAAAAA', 840000)).toEqual({ valid: true });
    });
    it('rejects names too early for current height', () => {
      const result = validateRuneName('SHORT', 840000);
      expect(result.valid).toBe(false);
    });
    it('rejects invalid characters', () => {
      const result = validateRuneName('HELLO WORLD', 840000);
      expect(result.valid).toBe(false);
    });
    it('accepts a 6-letter name at block 949303 if alphabetically high enough', () => {
      // ZZZZZZ should definitely be available
      const result = validateRuneName('ZZZZZZ', 949303);
      expect(result.valid).toBe(true);
    });
    it('rejects a 6-letter name at block 949303 if too early alphabetically', () => {
      // AAAAAA should not be available yet (it's near the end of the 6-char window)
      const result = validateRuneName('AAAAAA', 949303);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.unlockHeight).toBeGreaterThan(949303);
      }
    });
    it('shows the current minimum name in error message', () => {
      const result = validateRuneName('AAAAAA', 949303);
      if (!result.valid) {
        expect(result.error).toContain('minimum');
      }
    });
  });

  describe('computeUnlockHeight', () => {
    it('returns activation height for 13+ char names', () => {
      expect(computeUnlockHeight('AAAAAAAAAAAAA')).toBe(840000);
    });
    it('returns later height for shorter names', () => {
      expect(computeUnlockHeight('AAAAA')).toBeGreaterThan(960000);
    });
    it('ZZZZZZ unlocks earlier than AAAAAA', () => {
      const z6 = computeUnlockHeight('ZZZZZZ');
      const a6 = computeUnlockHeight('AAAAAA');
      expect(z6).toBeLessThan(a6);
    });
  });
});

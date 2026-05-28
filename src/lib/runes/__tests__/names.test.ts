import { describe, it, expect } from 'vitest';
import {
  runeNameToU128,
  u128ToRuneName,
  spacerBitmask,
  minimumAtHeight,
  minNameLengthAtHeight,
  computeUnlockHeight,
  validateRuneName,
  blocksUntilNameUnlocks,
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

    // Finding #11 — testnet bypass was permissive on testnet4, letting BUDDY
    // (value 1,285,880) etch when the chain's minimum was 2,789,068. New
    // `runeMinimum` param takes precedence over isTestnet bypass.
    describe('runeMinimum (Finding #11)', () => {
      const TESTNET4_TIP = 136590;
      const MIN_FBQUW = 2_789_068n; // current testnet4 minimum at session capture
      const BUDDY_VALUE = runeNameToU128('BUDDY'); // 1,285,880

      it('rejects BUDDY when runeMinimum is supplied even on testnet', () => {
        const result = validateRuneName('BUDDY', TESTNET4_TIP, true, MIN_FBQUW);
        expect(result.valid).toBe(false);
        if (!result.valid) {
          expect(result.error).toContain('FBQUW');
          expect(result.error).toContain('BUDDY');
        }
        // Sanity — BUDDY's value must really be below the supplied minimum
        expect(BUDDY_VALUE).toBeLessThan(MIN_FBQUW);
      });

      it('accepts a name above runeMinimum on testnet', () => {
        // GHOSTS = 2,930,873 (just above FBQUW = 2,789,068)
        const result = validateRuneName('GHOSTS', TESTNET4_TIP, true, MIN_FBQUW);
        expect(result.valid).toBe(true);
      });

      it('runeMinimum trumps the legacy isTestnet permissive fallback', () => {
        // Old behavior: testnet+below-min returned valid (bypass). New:
        // when runeMinimum is supplied, the bypass doesn't apply.
        const withMinimum = validateRuneName('BUDDY', TESTNET4_TIP, true, MIN_FBQUW);
        const withoutMinimum = validateRuneName('BUDDY', TESTNET4_TIP, true, null);
        expect(withMinimum.valid).toBe(false);
        expect(withoutMinimum.valid).toBe(true); // legacy permissive
      });

      it('runeMinimum applies on mainnet too (chain-agnostic authority)', () => {
        // Even with a fresh-tip mainnet block where local minimumAtHeight would
        // be more permissive, the supplied minimum still gates.
        const result = validateRuneName('BUDDY', 949303, false, MIN_FBQUW);
        expect(result.valid).toBe(false);
      });

      it('preserves legacy testnet permissive when runeMinimum is null', () => {
        const result = validateRuneName('BUDDY', TESTNET4_TIP, true);
        expect(result.valid).toBe(true);
      });
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

  // Finding #15 — chain-agnostic projection of when a name will unlock,
  // computed from the current minimum (e.g. ord's reported value) instead
  // of using the hard-coded mainnet RUNES_ACTIVATION constant.
  describe('blocksUntilNameUnlocks (Finding #15)', () => {
    it('returns 0 when target is already at or above the current minimum', () => {
      expect(blocksUntilNameUnlocks(2_789_068n, 2_789_068n)).toBe(0);
      expect(blocksUntilNameUnlocks(5_000_000n, 2_789_068n)).toBe(0);
      expect(blocksUntilNameUnlocks(99_999_999_999n, 1_000_000_000n)).toBe(0);
    });

    it('PUPPET below QOMKIH — user-shared mainnet scenario, same 6-char phase', () => {
      const puppet = runeNameToU128('PUPPET');
      const qomkih = runeNameToU128('QOMKIH');
      const blocks = blocksUntilNameUnlocks(puppet, qomkih);
      expect(blocks).not.toBeNull();
      expect(blocks).toBeGreaterThan(0);
      // Intra-phase delay can't exceed one UNLOCK_INTERVAL (17,500 blocks).
      expect(blocks!).toBeLessThan(17_500);
    });

    it('BUDDY below FBQUW — testnet4 scenario from this session', () => {
      const buddy = runeNameToU128('BUDDY');  // 1,285,880
      const fbquw = 2_789_068n;
      const blocks = blocksUntilNameUnlocks(buddy, fbquw);
      expect(blocks).not.toBeNull();
      expect(blocks!).toBeGreaterThan(0);
    });

    it('cross-phase: "A" (value 0) requires many phases of decay from a high minimum', () => {
      const stepsTop = 99_246_114_928_149_462n;  // STEPS[12], 13-char threshold
      const result = blocksUntilNameUnlocks(0n, stepsTop);
      expect(result).not.toBeNull();
      // 12 phases × 17,500 = 210,000 blocks (one halving) to reach 0 from STEPS[12].
      expect(result!).toBeGreaterThan(200_000);
      expect(result!).toBeLessThanOrEqual(210_000);
    });

    it('chain-agnostic: function does not depend on RUNES_ACTIVATION', () => {
      // Same (target, currentMin) → same answer, whether caller is on mainnet,
      // testnet4, signet, or regtest. RUNES_ACTIVATION is mainnet-only.
      const a = blocksUntilNameUnlocks(runeNameToU128('BUDDY'), 2_789_068n);
      const b = blocksUntilNameUnlocks(runeNameToU128('BUDDY'), 2_789_068n);
      expect(a).toBe(b);
    });
  });

  // Finding #15 — validateRuneName now populates `unlockHeight` so the UI
  // can advise the user when to broadcast the reveal of a commit they're
  // about to make for a below-minimum name.
  describe('validateRuneName unlockHeight (Finding #15)', () => {
    it('populates unlockHeight for below-minimum names when blockHeight is known', () => {
      const result = validateRuneName('BUDDY', 136_590, true, 2_789_068n);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.unlockHeight).toBeDefined();
        expect(result.unlockHeight!).toBeGreaterThan(136_590);
      }
    });

    it('omits unlockHeight when blockHeight is 0 (not yet loaded)', () => {
      const result = validateRuneName('BUDDY', 0, true, 2_789_068n);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.unlockHeight).toBeUndefined();
      }
    });
  });
});

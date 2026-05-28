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

  // Finding #15 EXACT-MATCH VERIFIER — brute-force check that my function's
  // prediction matches a direct minimumAtHeight search. This is the ground
  // truth: a name with value V is etchable at block X iff minimumAtHeight(X-1)
  // <= V. The earliest such X is the true unlock block. My function (anchored
  // at some block A with currentMinimum = minimumAtHeight(A-1)) must return
  // the exact integer such that A + result == earliest_unlock_block.
  describe('blocksUntilNameUnlocks — exact-match verification (Finding #15)', () => {
    // Direct ord-style search for the earliest block at which targetValue is
    // etchable without commit-reveal. Linear over blocks but bounded — only
    // searches within one halving (SUBSIDY_HALVING_INTERVAL = 210,000 blocks).
    function earliestUnlockBlock(targetValue: bigint, anchorBlock: number): number {
      const MAX = 1_200_000; // ample upper bound: any name unlocks by activation + 210k
      for (let b = anchorBlock; b <= MAX; b++) {
        if (minimumAtHeight(b - 1) <= targetValue) return b;
      }
      return -1;
    }

    function verifyExact(name: string, anchorBlock: number) {
      const targetValue = runeNameToU128(name);
      const currentMinimum = minimumAtHeight(anchorBlock - 1);

      if (targetValue >= currentMinimum) {
        expect(blocksUntilNameUnlocks(targetValue, anchorBlock)).toBe(0);
        return;
      }

      const predictedDelta = blocksUntilNameUnlocks(targetValue, anchorBlock);
      expect(predictedDelta).toBeGreaterThan(0);
      const predictedBlock = anchorBlock + predictedDelta;
      const actualBlock = earliestUnlockBlock(targetValue, anchorBlock);

      expect(predictedBlock).toBe(actualBlock);
    }

    // ---------- Same-phase cases ----------
    it('PUPPET at mainnet tip 951,350 (live ord-reported state)', () => {
      // mainnet block 951,350 has minimum_rune_for_next_block = QOMKIH = 209,074,197.
      // PUPPET = 199,990,693. Both 6-letter, same phase (length=6).
      verifyExact('PUPPET', 951_350);
    });

    it('QOMKIH itself at its barely-etchable block (predicts 0)', () => {
      verifyExact('QOMKIH', 951_350);
    });

    it('AAAAAA (early-alphabet 6-letter) at block 951,350', () => {
      // 6-letter but very low value; many blocks of decay required within phase.
      verifyExact('AAAAAA', 951_350);
    });

    it('ZZZZZZ (late-alphabet 6-letter) at block 951,350', () => {
      // ZZZZZZ value = 308,915,775. Above current QOMKIH min, already etchable.
      verifyExact('ZZZZZZ', 951_350);
    });

    // ---------- Cross-phase cases ----------
    it('AAAAA (5-letter) at block 951,350 — crosses one phase boundary', () => {
      // 5-letter names unlock starting in the next phase (block 962,500+).
      verifyExact('AAAAA', 951_350);
    });

    it('ABCD (4-letter) at block 951,350 — crosses two phase boundaries', () => {
      verifyExact('ABCD', 951_350);
    });

    it('AB (2-letter) at block 951,350 — crosses several phases', () => {
      verifyExact('AB', 951_350);
    });

    it('A (1-letter) at block 951,350 — must reach end of decay', () => {
      // 'A' = value 0. Only fully unlocks at end of halving (block 1,050,000).
      verifyExact('A', 951_350);
    });

    // ---------- Historical-block anchors ----------
    it('UNCOMMONGOODS (13-letter) — was etchable from mainnet activation', () => {
      // Activation block 840,000 minimum = STEPS[12]. Any 13+ char name unlocked.
      verifyExact('UNCOMMONGOODS', 840_001);
    });

    it('BITCOININSCRIBEDPHALLUS (23-letter) at block 840,300', () => {
      // The user's real rune etched 300 blocks after mainnet activation.
      // 23 chars → value far above STEPS[12] → was already unlocked.
      verifyExact('BITCOININSCRIBEDPHALLUS', 840_300);
    });

    it('HELLO (5-letter) anchored at mid-decay block 920,000', () => {
      // Mid-halving: minimum has dropped considerably from activation.
      verifyExact('HELLO', 920_000);
    });

    // ---------- Edge cases ----------
    it('boundary: name value equal to STEPS[5] (phase boundary)', () => {
      const stepsBoundary = 12_356_630n;  // STEPS[5] — first value with 6 chars
      const anchorBlock = 951_350;
      const predicted = blocksUntilNameUnlocks(stepsBoundary, anchorBlock);
      const actual = earliestUnlockBlock(stepsBoundary, anchorBlock);
      expect(anchorBlock + predicted).toBe(actual);
    });

    it('stress test: 50 random (name-value, anchor-block) pairs', () => {
      // Deterministic pseudo-random for reproducibility.
      let seed = 12345;
      function rand(max: number): number {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        return seed % max;
      }

      let mismatches: Array<{ name: string; anchor: number; predicted: number; actual: number }> = [];
      for (let i = 0; i < 50; i++) {
        const lenBucket = (i % 13) + 1; // names of length 1..13
        let name = '';
        for (let j = 0; j < lenBucket; j++) {
          name += String.fromCharCode(65 + rand(26));
        }
        const anchor = 840_000 + rand(200_000); // anywhere in the halving

        const value = runeNameToU128(name);
        const currentMin = minimumAtHeight(anchor - 1);
        const predicted = blocksUntilNameUnlocks(value, anchor);

        if (value >= currentMin) {
          if (predicted !== 0) {
            mismatches.push({ name, anchor, predicted, actual: 0 });
          }
          continue;
        }

        const predictedBlock = anchor + predicted;
        const actualBlock = earliestUnlockBlock(value, anchor);
        if (predictedBlock !== actualBlock) {
          mismatches.push({ name, anchor, predicted: predictedBlock, actual: actualBlock });
        }
      }
      expect(mismatches).toEqual([]);
    });
  });

  // Finding #15 — high-level smoke tests for the (target, currentBlockHeight)
  // API. The brute-force "exact-match verification" block above is the real
  // proof; these just verify the API contract.
  describe('blocksUntilNameUnlocks API (Finding #15)', () => {
    it('returns 0 when target is already above the minimum at currentBlockHeight', () => {
      // ZZZZZZZZZZZZZ (13 chars) value is far above any minimum.
      expect(blocksUntilNameUnlocks(runeNameToU128('ZZZZZZZZZZZZZ'), 951_350)).toBe(0);
    });

    it('returns a positive integer for below-minimum names', () => {
      const result = blocksUntilNameUnlocks(runeNameToU128('PUPPET'), 951_350);
      expect(result).toBeGreaterThan(0);
      // Intra-phase delay can't exceed one UNLOCK_INTERVAL (17,500 blocks).
      expect(result).toBeLessThan(17_500);
    });

    it('"A" (value 0) reaches full-unlock at activation + halving = 1,050,000', () => {
      // Anchored just past activation; should equal 210,000 blocks to fully open.
      const result = blocksUntilNameUnlocks(0n, 840_001);
      expect(result).toBe(209_999); // 1,050,000 - 840,001
    });
  });

  // Finding #15 — validateRuneName now populates `unlockHeight` on mainnet
  // (where we know the chain's RUNES_ACTIVATION) so the UI can advise the
  // user when to broadcast the reveal of a commit they're about to make.
  describe('validateRuneName unlockHeight (Finding #15)', () => {
    it('populates unlockHeight for below-minimum names on MAINNET', () => {
      // PUPPET below QOMKIH at mainnet tip 951,350.
      const puppetValue = runeNameToU128('PUPPET');
      const qomkihValue = runeNameToU128('QOMKIH');
      const result = validateRuneName('PUPPET', 951_350, false, qomkihValue);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.unlockHeight).toBeDefined();
        expect(result.unlockHeight!).toBeGreaterThan(951_350);
        // Cross-check: the unlock block is exactly 951_350 + blocksUntilNameUnlocks
        expect(result.unlockHeight).toBe(951_350 + blocksUntilNameUnlocks(puppetValue, 951_350));
      }
    });

    it('omits unlockHeight on TESTNET (we don\'t know testnet4 activation height)', () => {
      const result = validateRuneName('BUDDY', 136_590, true, 2_789_068n);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.unlockHeight).toBeUndefined();
      }
    });

    it('omits unlockHeight when blockHeight is 0 (chain tip not yet loaded)', () => {
      const result = validateRuneName('PUPPET', 0, false, runeNameToU128('QOMKIH'));
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.unlockHeight).toBeUndefined();
      }
    });
  });
});

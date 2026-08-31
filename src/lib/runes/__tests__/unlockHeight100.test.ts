import { describe, it, expect } from 'vitest';
import {
  runeNameToU128,
  minimumAtHeight,
  computeUnlockHeight,
  blocksUntilNameUnlocks,
} from '../names';

const RUNES_ACTIVATION = 840_000;
const SUBSIDY_HALVING_INTERVAL = 210_000;

/** Protocol ground truth: earliest block where name is etchable. */
function bruteForceUnlockBlock(name: string, startBlock = RUNES_ACTIVATION): number {
  const value = runeNameToU128(name);
  const maxBlock = RUNES_ACTIVATION + SUBSIDY_HALVING_INTERVAL;
  for (let block = startBlock; block <= maxBlock; block++) {
    if (minimumAtHeight(block - 1) <= value) return block;
  }
  return -1;
}

/** 100 diverse names across lengths 1–13 (7–8 per length, all unique). */
function build100TestNames(): string[] {
  const names: string[] = [];
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  for (let len = 1; len <= 13; len++) {
    const perLen = len <= 7 ? 8 : 7; // 8*7 + 7*6 = 98, pad with 2 extras
    for (let i = 0; i < perLen; i++) {
      const c = chars[i];
      if (len === 1) names.push(c);
      else if (i % 3 === 0) names.push(c.repeat(len));
      else if (i % 3 === 1) names.push('A'.repeat(len - 1) + c);
      else names.push(c + 'Z'.repeat(len - 1));
    }
  }
  for (const extra of ['BHANG', 'PUPPET']) {
    if (!names.includes(extra)) names.push(extra);
  }
  return names.slice(0, 100);
}

const TEST_NAMES = build100TestNames();

describe('100-name unlock block cross-verification', () => {
  it('generates exactly 100 unique names spanning lengths 1–13', () => {
    expect(TEST_NAMES).toHaveLength(100);
    expect(new Set(TEST_NAMES).size).toBe(100);
    const lengths = TEST_NAMES.map((n) => n.length);
    expect(Math.min(...lengths)).toBe(1);
    expect(Math.max(...lengths)).toBe(13);
  });

  it('computeUnlockHeight matches brute-force for all 100 names', () => {
    const mismatches: Array<{ name: string; ours: number; brute: number }> = [];
    for (const name of TEST_NAMES) {
      const ours = computeUnlockHeight(name);
      const brute = bruteForceUnlockBlock(name);
      if (ours !== brute) mismatches.push({ name, ours, brute });
    }
    expect(mismatches, JSON.stringify(mismatches, null, 2)).toEqual([]);
  });

  it('blocksUntilNameUnlocks from live tip matches brute-force (sample)', () => {
    const anchors = [840_000, 900_000, 951_350, 962_500, 979_145, 1_000_000];
    const sample = TEST_NAMES;
    for (const anchor of anchors) {
      for (const name of sample) {
        const value = runeNameToU128(name);
        const delta = blocksUntilNameUnlocks(value, anchor);
        const predicted = anchor + delta;
        const brute = bruteForceUnlockBlock(name, anchor);
        expect(predicted, `${name}@${anchor}`).toBe(brute);
      }
    }
  }, 120_000);

  it('unlock block passes protocol; block before fails (except activation edge)', () => {
    for (const name of TEST_NAMES) {
      const value = runeNameToU128(name);
      const unlock = computeUnlockHeight(name);
      expect(minimumAtHeight(unlock - 1)).toBeLessThanOrEqual(value);
      if (unlock > RUNES_ACTIVATION) {
        expect(minimumAtHeight(unlock - 2)).toBeGreaterThan(value);
      }
    }
  });
});

describe('100-name unlock block — real commit bundle names', () => {
  const BUNDLE_NAMES = [
    'BANDU', 'CWSAA', 'CYJAA', 'DAIUV', 'DDLJB', 'DUDUH', 'DUMMY', 'ZOBUS',
    'EBOLA', 'PIZZA', 'FISHY', 'WHITEFIELD', 'SWIMMING', 'ETCHINGRUNE',
    'VIJYA', 'CANNABISCOIN', 'WEEDCOIN', 'BHANG', 'PUPPET',
  ];

  it('computeUnlockHeight matches brute-force for every saved commit bundle name', () => {
    for (const name of BUNDLE_NAMES) {
      expect(computeUnlockHeight(name), name).toBe(bruteForceUnlockBlock(name));
    }
  });

  /** Legacy bundles exported before Finding #15 may be 1 block early (cenotaph risk). */
  it('flags legacy bundle targetUnlockHeight values that are one block too early', () => {
    const legacyStored: Array<[string, number]> = [
      ['PIZZA', 969_670],
      ['DAIUV', 977_972],
    ];
    for (const [name, stored] of legacyStored) {
      expect(stored, name).toBe(computeUnlockHeight(name) - 1);
    }
  });
});

describe('100-name unlock block — known regression constants', () => {
  it('matches documented exact unlock blocks from names.test.ts', () => {
    expect(computeUnlockHeight('PUPPET')).toBe(951_871);
    expect(computeUnlockHeight('AAAAAA')).toBe(962_500);
    expect(computeUnlockHeight('A')).toBe(1_050_000);
    expect(computeUnlockHeight('BHANG')).toBe(979_146);
    expect(computeUnlockHeight('AAAAAAAAAAAAA')).toBe(840_000);
  });
});

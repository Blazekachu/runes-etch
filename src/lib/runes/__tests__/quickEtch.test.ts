import { describe, it, expect } from 'vitest';
import { estimateQuickEtchVBytes } from '../quickEtch';

/**
 * Calibration test for Finding #1 — old estimator overshot a real testnet4
 * BUDDY etch (1 p2wpkh in, 1 p2tr dust, 1 OP_RETURN runestone, 1 p2wpkh change)
 * by 36% (247 estimated vs 181.25 actual vsize).
 *
 * New estimator must be honest: within ±5% of actual for realistic mixes.
 */
describe('estimateQuickEtchVBytes (per-type aware)', () => {
  it('matches BUDDY-style etch (1 p2wpkh in, 1 p2tr out, 1 OP_RETURN 25B, 1 p2wpkh change)', () => {
    // Real testnet4 vsize was 181.25 vB. 5% tolerance both ways.
    const vb = estimateQuickEtchVBytes(
      [{ type: 'p2wpkh' }],
      [
        { type: 'p2tr' },
        { type: 'op_return', scriptByteLen: 25 },
        { type: 'p2wpkh' },
      ],
    );
    expect(vb).toBeGreaterThanOrEqual(Math.floor(181.25 * 0.98));
    expect(vb).toBeLessThanOrEqual(Math.ceil(181.25 * 1.05));
  });

  it('matches a 1 p2tr in / 1 p2tr out / 1 OP_RETURN / 1 p2wpkh change etch', () => {
    // 10.5 (overhead) + 57.5 (p2tr in) + 43 + (9+30) + 31 = ~181 vB
    const vb = estimateQuickEtchVBytes(
      [{ type: 'p2tr' }],
      [
        { type: 'p2tr' },
        { type: 'op_return', scriptByteLen: 30 },
        { type: 'p2wpkh' },
      ],
    );
    expect(vb).toBeGreaterThanOrEqual(170);
    expect(vb).toBeLessThanOrEqual(190);
  });

  it('scales linearly per p2wpkh input (each +68 vB)', () => {
    const one = estimateQuickEtchVBytes(
      [{ type: 'p2wpkh' }],
      [{ type: 'op_return', scriptByteLen: 20 }],
    );
    const two = estimateQuickEtchVBytes(
      [{ type: 'p2wpkh' }, { type: 'p2wpkh' }],
      [{ type: 'op_return', scriptByteLen: 20 }],
    );
    expect(two - one).toBe(68);
  });

  it('scales linearly per p2tr input (each +58 vB, rounded)', () => {
    const one = estimateQuickEtchVBytes(
      [{ type: 'p2tr' }],
      [{ type: 'op_return', scriptByteLen: 20 }],
    );
    const two = estimateQuickEtchVBytes(
      [{ type: 'p2tr' }, { type: 'p2tr' }],
      [{ type: 'op_return', scriptByteLen: 20 }],
    );
    // 57.5 vB per p2tr input, but we ceil at the end, so delta is 57 or 58
    expect(two - one).toBeGreaterThanOrEqual(57);
    expect(two - one).toBeLessThanOrEqual(58);
  });

  it('OP_RETURN output vB = 9 + scriptByteLen', () => {
    const small = estimateQuickEtchVBytes(
      [{ type: 'p2wpkh' }],
      [{ type: 'op_return', scriptByteLen: 10 }],
    );
    const large = estimateQuickEtchVBytes(
      [{ type: 'p2wpkh' }],
      [{ type: 'op_return', scriptByteLen: 50 }],
    );
    expect(large - small).toBe(40);
  });

  it('p2wpkh output vB is 31 (vs 43 for p2tr — 12 vB cheaper per change output)', () => {
    const p2wpkhChange = estimateQuickEtchVBytes(
      [{ type: 'p2wpkh' }],
      [{ type: 'op_return', scriptByteLen: 20 }, { type: 'p2wpkh' }],
    );
    const p2trChange = estimateQuickEtchVBytes(
      [{ type: 'p2wpkh' }],
      [{ type: 'op_return', scriptByteLen: 20 }, { type: 'p2tr' }],
    );
    expect(p2trChange - p2wpkhChange).toBe(12);
  });
});

import { describe, expect, it } from 'vitest';
import { resolveRevealChangeAddress } from '../revealChangeAddress';

describe('resolveRevealChangeAddress', () => {
  it('prefers commit-locked change address when present', () => {
    expect(
      resolveRevealChangeAddress('tb1qlocked', 'tb1qpayment', 'tb1ptaproot'),
    ).toBe('tb1qlocked');
  });

  it('falls back to payment address when commit change address is blank', () => {
    expect(
      resolveRevealChangeAddress('', 'tb1qpayment', 'tb1ptaproot'),
    ).toBe('tb1qpayment');
  });

  it('falls back to taproot as a final fallback', () => {
    expect(
      resolveRevealChangeAddress('', '', 'tb1ptaproot'),
    ).toBe('tb1ptaproot');
  });
});

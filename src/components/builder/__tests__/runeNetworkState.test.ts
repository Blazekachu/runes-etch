import { describe, expect, it } from 'vitest';
import { canValidateRuneNetworkState, resetRuneNetworkState } from '../runeNetworkState';

describe('rune network state', () => {
  it('clears stale height and minimum before a wallet network refetch', () => {
    expect(resetRuneNetworkState()).toEqual({
      blockHeight: 0,
      runeMinimum: null,
    });
  });

  it('does not validate rune unlocks without a fresh chain height', () => {
    expect(canValidateRuneNetworkState({ blockHeight: 0, runeMinimum: 123n })).toBe(false);
    expect(canValidateRuneNetworkState({ blockHeight: 138073, runeMinimum: 123n })).toBe(true);
  });
});

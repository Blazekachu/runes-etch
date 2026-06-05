import { describe, expect, it } from 'vitest';
import { getBuildBlockReason } from '../buildReadiness';

describe('getBuildBlockReason', () => {
  const ready = {
    walletConnected: true,
    hasRuneName: true,
    hasFunding: true,
    selectedFeeRate: 10,
    productReady: true,
    productMode: 'rune' as const,
    hasChild: false,
    hasParent: false,
    reinscribeMode: false,
    reinscribePrimaryValid: true,
    targetVerifyState: 'idle' as const,
  };

  it('does not block pure rune commit based on rune name availability state', () => {
    expect(getBuildBlockReason(ready)).toBeNull();
  });

  it('explains missing product requirements instead of silently disabling', () => {
    expect(getBuildBlockReason({
      ...ready,
      productReady: false,
      productMode: 'parent-child',
      hasChild: false,
      hasParent: true,
    })).toBe('Add a child inscription or delegate for Parent Child mode.');
  });

  it('allows verified target funding without picker-selected UTXOs', () => {
    expect(getBuildBlockReason({
      ...ready,
      hasFunding: true,
      targetVerifyState: 'ok',
    })).toBeNull();
  });
});

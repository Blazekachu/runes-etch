import { describe, expect, it, vi } from 'vitest';
import { runeNameToU128 } from '../names';
import {
  canBroadcastRevealAtCurrentConfirmations,
  getFreshRevealNameGate,
  REVEAL_BROADCAST_CONFIRMATIONS,
} from '../revealSafety';

describe('reveal safety gates', () => {
  it('allows reveal broadcast at 5 current confirmations', () => {
    expect(REVEAL_BROADCAST_CONFIRMATIONS).toBe(5);
    expect(canBroadcastRevealAtCurrentConfirmations(4)).toBe(false);
    expect(canBroadcastRevealAtCurrentConfirmations(5)).toBe(true);
  });

  it('refreshes height and minimum immediately before final reveal gating', async () => {
    const getCurrentBlockHeight = vi.fn(async () => 951350);
    const getRuneMinimumFromOrd = vi.fn(async () => runeNameToU128('QOMKIH'));

    const gate = await getFreshRevealNameGate({
      runeName: 'PUPPET',
      isTestnet: false,
      fallbackBlockHeight: 123,
      fallbackRuneMinimum: null,
      getCurrentBlockHeight,
      getRuneMinimumFromOrd,
    });

    expect(getCurrentBlockHeight).toHaveBeenCalledOnce();
    expect(getRuneMinimumFromOrd).toHaveBeenCalledOnce();
    expect(gate.status).toBe('locked');
    if (gate.status === 'locked') {
      expect(gate.currentHeight).toBe(951350);
      expect(gate.unlockHeight).toBe(951871);
    }
  });

  it('uses explicit testnet4 chain height for testnet reveal gating', async () => {
    const getCurrentBlockHeightForChain = vi.fn(async (chain: string) => {
      expect(chain).toBe('testnet4');
      return 138072;
    });
    const getRuneMinimumFromOrd = vi.fn(async () => runeNameToU128('CWKJN'));

    const gate = await getFreshRevealNameGate({
      runeName: 'BUDDY',
      isTestnet: true,
      fallbackBlockHeight: 952494,
      fallbackRuneMinimum: null,
      getCurrentBlockHeightForChain,
      getRuneMinimumFromOrd,
    });

    expect(getCurrentBlockHeightForChain).toHaveBeenCalledWith('testnet4');
    expect(gate.status).toBe('locked');
    if (gate.status === 'locked') {
      expect(gate.currentHeight).toBe(138072);
      expect(gate.unlockHeight).toBe(138806);
    }
  });
});

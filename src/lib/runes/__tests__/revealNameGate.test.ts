import { describe, expect, it } from 'vitest';
import { runeNameToU128 } from '../names';
import { formatLockedNameWarning, getRevealNameGate } from '../revealNameGate';

describe('getRevealNameGate', () => {
  it('allows names above the current protocol minimum', () => {
    const gate = getRevealNameGate({
      runeName: 'ZZZZZZ',
      currentBlockHeight: 951_350,
      isTestnet: false,
      runeMinimum: runeNameToU128('QOMKIH'),
    });

    expect(gate.status).toBe('ok');
  });

  it('classifies below-minimum mainnet names as locked with an unlock height', () => {
    const gate = getRevealNameGate({
      runeName: 'PUPPET',
      currentBlockHeight: 951_350,
      isTestnet: false,
      runeMinimum: runeNameToU128('QOMKIH'),
    });

    expect(gate.status).toBe('locked');
    if (gate.status === 'locked') {
      expect(gate.unlockHeight).toBeGreaterThan(951_350);
      expect(formatLockedNameWarning(gate)).toContain('Name unlocks at block');
      expect(formatLockedNameWarning(gate)).toContain('cenotaph');
    }
  });

  it('classifies below-minimum testnet names as locked with the precise unlock height', () => {
    const gate = getRevealNameGate({
      runeName: 'BUDDY',
      currentBlockHeight: 138_072,
      isTestnet: true,
      runeMinimum: runeNameToU128('CWKJN'),
    });

    expect(gate.status).toBe('locked');
    if (gate.status === 'locked') {
      expect(gate.unlockHeight).toBe(138_806);
      expect(gate.currentMinimumName).toBe('CWKJN');
      expect(formatLockedNameWarning(gate)).toContain('Name unlocks at block 138,806');
      expect(formatLockedNameWarning(gate)).toContain('override will likely create a cenotaph');
    }
  });

  it('keeps malformed names as invalid, not overrideable locked names', () => {
    const gate = getRevealNameGate({
      runeName: 'BAD1',
      currentBlockHeight: 951_350,
      isTestnet: false,
      runeMinimum: runeNameToU128('QOMKIH'),
    });

    expect(gate.status).toBe('invalid');
  });
});

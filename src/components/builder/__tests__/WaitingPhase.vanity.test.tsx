import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import WaitingPhase from '../WaitingPhase';
import { useBuilderStore } from '@/store/builderStore';

vi.mock('@/lib/api/mempool', () => ({
  getTxConfirmations: vi.fn(async () => 0),
  bitcoinNetworkForWallet: vi.fn(() => 'testnet'),
  setMempoolNetwork: vi.fn(),
  fetchFeeRates: vi.fn(async () => ({ fastestFee: 5, halfHourFee: 3, economyFee: 1 })),
}));

vi.mock('@/lib/api/ordinals', () => ({
  setOrdinalsForWallet: vi.fn(),
}));

vi.mock('@/lib/wallet/xverse', () => ({
  connectWallet: vi.fn(),
  getActiveProvider: vi.fn(() => null),
}));

vi.mock('@/lib/bundle/export', () => ({
  createCommitBundle: vi.fn(),
  downloadBundle: vi.fn(),
}));

vi.mock('@/lib/vanity/grinder', () => ({
  VanityGrinder: vi.fn().mockImplementation(() => ({
    start: vi.fn(),
    stop: vi.fn(),
  })),
}));

describe('WaitingPhase reveal vanity recovery', () => {
  beforeEach(() => {
    localStorage.clear();
    useBuilderStore.getState().reset();
    useBuilderStore.setState({
      phase: 'waiting',
      etching: {
        ...useBuilderStore.getState().etching,
        runeName: 'ZZZZZZ',
      },
      vanityConfig: { prefix: '420', suffix: '' },
      commitState: {
        txid: 'a'.repeat(64),
        rawHex: '',
        confirmations: 5,
        commitOutputIndex: 0,
        commitOutputValue: 2327,
        changeAddress: 'tb1qchange',
      },
    });
  });

  it('lets the user re-enable vanity after skipping without a hard refresh', () => {
    render(<WaitingPhase />);

    fireEvent.click(screen.getByRole('button', { name: /skip vanity/i }));

    expect(screen.getByText(/vanity grinding skipped/i)).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /use vanity instead/i }));

    expect(screen.getByRole('button', { name: /skip vanity/i })).not.toBeNull();
  });
});

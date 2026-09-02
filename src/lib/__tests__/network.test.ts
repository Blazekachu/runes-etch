import { describe, expect, it } from 'vitest';
import { parseWalletNetworkName, walletChain, isRegtestAddress, isSignetAddress } from '../network';

describe('network helpers', () => {
  it('maps sats-connect network names to our chain enum', () => {
    expect(parseWalletNetworkName('Mainnet')).toBe('mainnet');
    expect(parseWalletNetworkName('Signet')).toBe('signet');
    expect(parseWalletNetworkName('Regtest')).toBe('regtest');
    expect(parseWalletNetworkName('Testnet4')).toBe('signet');
    expect(parseWalletNetworkName('Testnet')).toBe('signet');
  });

  it('falls back to signet for tb1 addresses when wallet name is missing', () => {
    expect(parseWalletNetworkName(undefined, 'tb1qxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx')).toBe('signet');
  });

  it('falls back to regtest for bcrt1 addresses when wallet name is missing', () => {
    expect(parseWalletNetworkName(undefined, 'bcrt1qxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx')).toBe('regtest');
  });

  it('resolves wallet chain from persisted network field', () => {
    expect(walletChain({
      network: 'signet',
      taprootAddress: 'bc1pxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
      paymentAddress: '',
    })).toBe('signet');
    expect(walletChain({
      network: 'regtest',
      taprootAddress: 'bcrt1pxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
      paymentAddress: '',
    })).toBe('regtest');
  });

  it('distinguishes regtest bcrt1 from signet tb1 by prefix', () => {
    expect(isRegtestAddress('bcrt1qtest')).toBe(true);
    expect(isSignetAddress('bcrt1qtest')).toBe(false);
    expect(isSignetAddress('tb1qtest')).toBe(true);
  });
});

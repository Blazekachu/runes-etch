import type { WalletState } from '@/types';

/** Active Bitcoin chain for the connected wallet session. */
export type BitcoinChain = 'mainnet' | 'signet' | 'regtest';

/** Mempool / ord API chain identifier (ord `/status` `chain` field values). */
export type MempoolChainId = 'bitcoin' | 'signet' | 'regtest' | 'testnet4' | 'testnet3';

export function isNonMainnet(chain: BitcoinChain): boolean {
  return chain !== 'mainnet';
}

/** True for signet/testnet address prefixes (tb1, legacy P2PKH/P2SH). */
export function isSignetAddress(address?: string): boolean {
  return !!address && (
    address.startsWith('tb1') ||
    address.startsWith('2') ||
    address.startsWith('m') ||
    address.startsWith('n')
  );
}

/** True for regtest bech32 address prefixes. */
export function isRegtestAddress(address?: string): boolean {
  return !!address && address.startsWith('bcrt1');
}

/** True for signet/testnet/regtest-style address prefixes (tb1, bcrt1, legacy P2PKH/P2SH). */
export function isNonMainnetAddress(address?: string): boolean {
  return isSignetAddress(address) || isRegtestAddress(address);
}

/**
 * Parse sats-connect `network.bitcoin.name` into our chain enum.
 * Testnet4 was the previous dev chain (pre-Aug 2026); wallet/network responses
 * may still report it — we route those to signet now.
 */
export function parseWalletNetworkName(name: string | undefined, address?: string): BitcoinChain {
  if (name === 'Mainnet') return 'mainnet';
  if (name === 'Signet') return 'signet';
  if (name === 'Regtest') return 'regtest';
  // Legacy: testnet4 era — same tb1 addresses, local ord required (Finding #11 context).
  if (name === 'Testnet4' || name === 'Testnet') return 'signet';
  if (address?.startsWith('bcrt1')) return 'regtest';
  if (isSignetAddress(address)) return 'signet';
  return 'mainnet';
}

/** Resolve chain from wallet state (persisted sessions may predate `network` field). */
export function walletChain(
  wallet: { network?: BitcoinChain; taprootAddress: string; paymentAddress: string },
): BitcoinChain {
  if (wallet.network) return wallet.network;
  if (isRegtestAddress(wallet.taprootAddress) || isRegtestAddress(wallet.paymentAddress)) {
    return 'regtest';
  }
  if (isSignetAddress(wallet.taprootAddress) || isSignetAddress(wallet.paymentAddress)) {
    return 'signet';
  }
  return 'mainnet';
}

export function chainLabel(chain: BitcoinChain): string {
  if (chain === 'regtest') return 'Regtest';
  if (chain === 'signet') return 'Signet';
  return 'Mainnet';
}

export function mempoolExplorerTxBase(chain: BitcoinChain): string {
  if (chain === 'regtest') return 'http://127.0.0.1:3003/tx';
  if (chain === 'signet') return 'https://mempool.space/signet/tx';
  return 'https://mempool.space/tx';
}

export function ordChainName(chain: BitcoinChain): MempoolChainId {
  if (chain === 'regtest') return 'regtest';
  if (chain === 'signet') return 'signet';
  return 'bitcoin';
}

/** Map ord-reported chain string to mempool provider key (handles legacy testnet4 ord). */
export function mempoolChainFromOrdReported(chain: string | undefined, sessionChain: BitcoinChain): MempoolChainId {
  if (chain === 'regtest') return 'regtest';
  if (chain === 'signet') return 'signet';
  if (chain === 'testnet4' || chain === 'testnet' || chain === 'testnet3') return 'testnet4';
  if (chain === 'bitcoin' || chain === 'mainnet' || chain === 'main') return 'bitcoin';
  return ordChainName(sessionChain);
}

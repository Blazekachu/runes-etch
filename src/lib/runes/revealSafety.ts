import { getChainTipForChain } from '@/lib/api/mempool';
import { getRuneMinimumFromOrdForChain } from '@/lib/api/ordinals';
import type { BitcoinChain } from '@/lib/network';
import { isNonMainnet, ordChainName } from '@/lib/network';
import { getRevealNameGate, type RevealNameGate } from './revealNameGate';

export const REVEAL_BROADCAST_CONFIRMATIONS = 5;

export function canBroadcastRevealAtCurrentConfirmations(confirmations: number): boolean {
  return confirmations >= REVEAL_BROADCAST_CONFIRMATIONS;
}

export async function getFreshRevealNameGate(params: {
  runeName: string;
  chain: BitcoinChain;
  /** @deprecated Prefer `chain`. Kept for tests — signet replaces testnet4. */
  isTestnet?: boolean;
  fallbackBlockHeight: number;
  fallbackRuneMinimum: bigint | null;
  getCurrentBlockHeight?: () => Promise<number>;
  getCurrentBlockHeightForChain?: (chain: string) => Promise<number>;
  getRuneMinimumFromOrd?: () => Promise<bigint | null>;
}): Promise<RevealNameGate> {
  const chain = params.chain ?? (params.isTestnet ? 'signet' : 'mainnet');
  const mempoolChain = ordChainName(chain);
  const fetchHeight = params.getCurrentBlockHeightForChain
    ? () => params.getCurrentBlockHeightForChain!(mempoolChain)
    : params.getCurrentBlockHeight
      ? params.getCurrentBlockHeight
      : () => getChainTipForChain(mempoolChain);
  const fetchMinimum = params.getRuneMinimumFromOrd ?? (() => getRuneMinimumFromOrdForChain(chain));

  const [freshHeight, freshMinimum] = await Promise.all([
    fetchHeight().catch(() => params.fallbackBlockHeight),
    fetchMinimum().catch(() => params.fallbackRuneMinimum),
  ]);

  return getRevealNameGate({
    runeName: params.runeName,
    currentBlockHeight: freshHeight,
    isNonMainnet: isNonMainnet(chain),
    runeMinimum: freshMinimum ?? params.fallbackRuneMinimum,
  });
}

import { getChainTipForChain } from '@/lib/api/mempool';
import { getRuneMinimumFromOrdForNetwork } from '@/lib/api/ordinals';
import { getRevealNameGate, type RevealNameGate } from './revealNameGate';

export const REVEAL_BROADCAST_CONFIRMATIONS = 5;

export function canBroadcastRevealAtCurrentConfirmations(confirmations: number): boolean {
  return confirmations >= REVEAL_BROADCAST_CONFIRMATIONS;
}

export async function getFreshRevealNameGate(params: {
  runeName: string;
  isTestnet: boolean;
  fallbackBlockHeight: number;
  fallbackRuneMinimum: bigint | null;
  getCurrentBlockHeight?: () => Promise<number>;
  getCurrentBlockHeightForChain?: (chain: string) => Promise<number>;
  getRuneMinimumFromOrd?: () => Promise<bigint | null>;
}): Promise<RevealNameGate> {
  const chain = params.isTestnet ? 'testnet4' : 'bitcoin';
  const fetchHeight = params.getCurrentBlockHeightForChain
    ? () => params.getCurrentBlockHeightForChain!(chain)
    : params.getCurrentBlockHeight
      ? params.getCurrentBlockHeight
      : () => getChainTipForChain(chain);
  const fetchMinimum = params.getRuneMinimumFromOrd ?? (() => getRuneMinimumFromOrdForNetwork(params.isTestnet));

  const [freshHeight, freshMinimum] = await Promise.all([
    fetchHeight().catch(() => params.fallbackBlockHeight),
    fetchMinimum().catch(() => params.fallbackRuneMinimum),
  ]);

  return getRevealNameGate({
    runeName: params.runeName,
    currentBlockHeight: freshHeight,
    isTestnet: params.isTestnet,
    runeMinimum: freshMinimum ?? params.fallbackRuneMinimum,
  });
}

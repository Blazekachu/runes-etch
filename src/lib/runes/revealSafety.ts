import { getCurrentBlockHeight } from '@/lib/api/mempool';
import { getRuneMinimumFromOrd } from '@/lib/api/ordinals';
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
  getRuneMinimumFromOrd?: () => Promise<bigint | null>;
}): Promise<RevealNameGate> {
  const fetchHeight = params.getCurrentBlockHeight ?? getCurrentBlockHeight;
  const fetchMinimum = params.getRuneMinimumFromOrd ?? getRuneMinimumFromOrd;

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

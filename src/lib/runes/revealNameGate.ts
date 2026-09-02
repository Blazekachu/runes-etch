import { u128ToRuneName, validateRuneName } from './names';

export type RevealNameGate =
  | { status: 'ok' }
  | { status: 'invalid'; message: string }
  | {
      status: 'locked';
      message: string;
      currentHeight: number;
      unlockHeight: number | null;
      currentMinimumName: string | null;
    };

export function getRevealNameGate(params: {
  runeName: string;
  currentBlockHeight: number;
  /** Non-mainnet chain (signet; was testnet4). Mainnet minimumAtHeight() is wrong here. */
  isNonMainnet: boolean;
  /** @deprecated Prefer isNonMainnet. */
  isTestnet?: boolean;
  runeMinimum: bigint | null;
}): RevealNameGate {
  const isNonMainnet = params.isNonMainnet ?? params.isTestnet ?? false;
  const validation = validateRuneName(
    params.runeName,
    params.currentBlockHeight,
    isNonMainnet,
    params.runeMinimum,
  );

  if (validation.valid) return { status: 'ok' };
  if (!validation.error.includes('minimum') && !validation.error.includes('unlocks at block')) {
    return { status: 'invalid', message: validation.error };
  }

  const currentMinimumName = params.runeMinimum !== null ? u128ToRuneName(params.runeMinimum) : null;
  return {
    status: 'locked',
    message: validation.error,
    currentHeight: params.currentBlockHeight,
    unlockHeight: validation.unlockHeight ?? null,
    currentMinimumName,
  };
}

export function formatLockedNameWarning(gate: Extract<RevealNameGate, { status: 'locked' }>): string {
  const formatHeight = (height: number) => height.toLocaleString('en-US');
  const heightText = gate.unlockHeight !== null
    ? `Name unlocks at block ${formatHeight(gate.unlockHeight)}. Current height is ${formatHeight(gate.currentHeight)}.`
    : gate.currentMinimumName
      ? `Current minimum etchable name is ${gate.currentMinimumName}.`
      : 'Current protocol minimum could not be projected to an exact unlock height.';
  return `${heightText} If you override and broadcast before that protocol unlock, override will likely create a cenotaph.`;
}

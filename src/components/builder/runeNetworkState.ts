export interface RuneNetworkState {
  blockHeight: number;
  runeMinimum: bigint | null;
}

export function resetRuneNetworkState(): RuneNetworkState {
  return { blockHeight: 0, runeMinimum: null };
}

export function canValidateRuneNetworkState(state: RuneNetworkState): boolean {
  return state.blockHeight > 0;
}

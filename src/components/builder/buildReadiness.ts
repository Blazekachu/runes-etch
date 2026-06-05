import type { ProductMode } from '@/types';

type TargetVerifyState = 'idle' | 'verifying' | 'ok' | 'error';

export interface BuildReadiness {
  walletConnected: boolean;
  hasRuneName: boolean;
  hasFunding: boolean;
  selectedFeeRate: number;
  productReady: boolean;
  productMode: ProductMode;
  hasChild: boolean;
  hasParent: boolean;
  reinscribeMode: boolean;
  reinscribePrimaryValid: boolean;
  targetVerifyState: TargetVerifyState;
}

export function getBuildBlockReason(input: BuildReadiness): string | null {
  if (!input.walletConnected) return 'Connect wallet to build the commit transaction.';
  if (!input.hasRuneName) return 'Enter a rune name.';
  if (input.targetVerifyState === 'verifying') return 'Wait for target verification to finish.';
  if (input.targetVerifyState === 'error') return 'Fix or clear the failed target UTXO verification.';
  if (input.selectedFeeRate <= 0) return 'Choose a commit fee rate.';

  if (!input.productReady) {
    if (input.productMode === 'parent-child') {
      if (!input.hasParent) return 'Resolve the parent inscription for Parent Child mode.';
      if (!input.hasChild) return 'Add a child inscription or delegate for Parent Child mode.';
    }
    if (input.productMode === 'rune-inscription') {
      return 'Add an inscription file, text inscription, or delegate inscription.';
    }
    return 'Refresh mode state; Rune mode should not require parent or inscription data.';
  }

  if (!input.hasFunding) return 'Select a funding UTXO or verify a target UTXO.';
  if (input.reinscribeMode && !input.reinscribePrimaryValid) {
    return 'Select an inscription UTXO as primary, or verify a target inscription.';
  }

  return null;
}

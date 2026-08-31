import type { PsbtKeyMaterial } from '@/lib/runes/psbtInputs';
import type { WalletState } from '@/types';

export function walletToPsbtKeys(
  wallet: WalletState,
  ordinalsInternalPubkey: Buffer,
): PsbtKeyMaterial {
  return {
    ordinalsInternalPubkey,
    ordinalsAddress: wallet.taprootAddress,
    paymentAddress: wallet.paymentAddress,
    paymentPublicKey: wallet.paymentPublicKey
      ? Buffer.from(wallet.paymentPublicKey, 'hex')
      : undefined,
  };
}

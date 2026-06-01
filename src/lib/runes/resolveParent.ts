import { getInscription, getOutput } from '@/lib/api/ordinals';
import type { ParentInscription } from '@/types';

export type ParentResolveResult =
  | { ok: true; parent: ParentInscription; owned: boolean }
  | { ok: false; error: string };

const INSCRIPTION_ID_REGEX = /^[0-9a-fA-F]{64}i\d+$/;

/**
 * Resolve a parent inscription ID to its CURRENT UTXO (txid:vout + value + owner).
 *
 * The reveal of a Full etch must spend this UTXO to prove parent ownership — so the
 * parent must be (re-)resolved to its live location, not just remembered by ID (the
 * inscription may have moved since commit). Shared by ParentSection (building phase)
 * and WaitingPhase (bundle-resume re-resolution — Punch List #10).
 *
 * Testnet: ordinals.com is mainnet-only, so derive the outpoint from the ID and look
 * up the value via the wallet's mempool UTXO set (trusts the user if it isn't on their
 * address). Mainnet: resolve via ord (getInscription + getOutput) and check ownership.
 */
export async function resolveParentInscription(
  id: string,
  wallet: { taprootAddress: string; paymentAddress: string },
): Promise<ParentResolveResult> {
  const trimmed = id.trim();
  if (!INSCRIPTION_ID_REGEX.test(trimmed)) {
    return { ok: false, error: 'Invalid inscription ID format.' };
  }

  const isTestnet = wallet.taprootAddress.startsWith('tb1');
  if (isTestnet) {
    try {
      const [txid, indexStr] = trimmed.split('i');
      const vout = parseInt(indexStr, 10) || 0;
      const { fetchUtxos } = await import('@/lib/api/mempool');
      const utxos = await fetchUtxos(wallet.taprootAddress);
      const utxo = utxos.find((u) => u.txid === txid && u.vout === vout);
      // UTXO not on our address → trust the user, use dummy dust value.
      const value = utxo?.value ?? 546;
      return {
        ok: true,
        parent: { inscriptionId: trimmed, txid, vout, value, address: wallet.taprootAddress },
        owned: true,
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Failed to verify on testnet' };
    }
  }

  try {
    const info = await getInscription(trimmed);
    const [txid, voutStr] = info.output.split(':');
    const vout = parseInt(voutStr, 10);
    const outputInfo = await getOutput(txid, vout);
    const ownerAddress = info.address;
    const owned = ownerAddress === wallet.taprootAddress || ownerAddress === wallet.paymentAddress;
    return {
      ok: true,
      parent: { inscriptionId: trimmed, txid, vout, value: outputInfo.value, address: ownerAddress },
      owned,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Inscription not found' };
  }
}

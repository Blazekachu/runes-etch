import { getInscription, getOutput, isPublicOrdForCurrentNetwork } from '@/lib/api/ordinals';
import type { ParentInscription } from '@/types';

export type ParentResolveResult =
  | { ok: true; parent: ParentInscription; owned: boolean }
  | { ok: false; error: string };

const INSCRIPTION_ID_REGEX = /^[0-9a-fA-F]{64}i\d+$/;
const TXID_REGEX = /^[0-9a-fA-F]{64}$/;

/**
 * Resolve a parent inscription ID to its CURRENT UTXO (txid:vout + value + owner).
 *
 * The reveal of a Full etch must spend this UTXO to prove parent ownership — so the
 * parent must be resolved to its LIVE location, not the location implied by the ID.
 * An inscription ID encodes its *genesis* output; once the inscription moves (wallet
 * consolidation, trades), that genesis output is spent and spending it makes the
 * reveal fail with `bad-txns-inputs-missingorspent` (Punch List #12).
 *
 * ord knows the current location. We use it whenever it can answer for this network:
 *  - mainnet: always (public ordinals.com indexes mainnet)
 *  - testnet: only when a local indexer is configured (NEXT_PUBLIC_ORD_BASE_TESTNET);
 *    public ordinals.com is mainnet-only and would 404 a testnet id.
 *
 * The current location lives in the inscription's `satpoint` ("txid:vout:offset").
 * (Some ord builds omit the legacy `output` field — satpoint is always present.)
 *
 * Only when on testnet WITHOUT a local indexer do we fall back to the degraded
 * genesis-outpoint guess (best-effort, can't verify ownership or that it's unspent).
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
  const ordCanResolve = !isTestnet || !isPublicOrdForCurrentNetwork();

  if (ordCanResolve) {
    try {
      const info = await getInscription(trimmed);
      // satpoint = "<txid>:<vout>:<offset>" — the inscription's live UTXO.
      const [txid, voutStr] = info.satpoint.split(':');
      const vout = parseInt(voutStr, 10);
      if (!TXID_REGEX.test(txid) || !Number.isInteger(vout)) {
        return { ok: false, error: `Could not parse parent location from ord: ${info.satpoint}` };
      }
      const output = await getOutput(txid, vout);
      const ownerAddress = info.address;
      const owned =
        ownerAddress === wallet.taprootAddress || ownerAddress === wallet.paymentAddress;
      return {
        ok: true,
        parent: { inscriptionId: trimmed, txid, vout, value: output.value, address: ownerAddress },
        owned,
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Inscription not found' };
    }
  }

  // Degraded fallback — testnet with no local indexer. We cannot learn the current
  // location or owner, so trust the user and best-effort the genesis outpoint.
  try {
    const [txid, indexStr] = trimmed.split('i');
    const vout = parseInt(indexStr, 10) || 0;
    const { fetchUtxos } = await import('@/lib/api/mempool');
    const utxos = await fetchUtxos(wallet.taprootAddress);
    const utxo = utxos.find((u) => u.txid === txid && u.vout === vout);
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

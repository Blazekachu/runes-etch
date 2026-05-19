import type {
  CommitBundle, BundleValidation, CommitTxState,
  RuneEtching, InscriptionFile, ParentInscription,
} from '@/types';
import { fetchUtxos, getCurrentBlockHeight } from '@/lib/api/mempool';
import { checkRuneNameAvailable, resolveParentForReveal } from '@/lib/api/ordinals';
import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';

bitcoin.initEccLib(ecc);

const HEX64_RE = /^[0-9a-f]{64}$/i;
const HEX_RE = /^[0-9a-f]+$/i;
const RUNE_NAME_RE = /^[A-Z]+$/;

export function parseBundle(jsonString: string): CommitBundle | null {
  try {
    const data = JSON.parse(jsonString);
    // H5: Thorough validation of bundle fields
    if (data.version !== 1 || data.type !== 'runes-etch-commit') return null;

    // Required string fields
    if (typeof data.commitTxid !== 'string' || !HEX64_RE.test(data.commitTxid)) return null;
    if (typeof data.runeName !== 'string' || !RUNE_NAME_RE.test(data.runeName)) return null;
    if (typeof data.tapscriptHex !== 'string' || !HEX_RE.test(data.tapscriptHex)) return null;
    if (typeof data.controlBlockHex !== 'string' || !HEX_RE.test(data.controlBlockHex)) return null;
    if (typeof data.internalPubkeyHex !== 'string' || !HEX_RE.test(data.internalPubkeyHex)) return null;
    if (data.internalPubkeyHex.length !== 64) return null; // 32 bytes = 64 hex chars

    // Required numeric fields
    if (typeof data.commitOutputIndex !== 'number' || data.commitOutputIndex < 0) return null;
    if (typeof data.commitOutputValue !== 'number' || data.commitOutputValue <= 0) return null;
    if (typeof data.targetUnlockHeight !== 'number') return null;

    // Etching object
    if (!data.etching || typeof data.etching !== 'object') return null;
    if (typeof data.etching.premine !== 'string') return null;
    try { const v = BigInt(data.etching.premine); if (v < 0n) return null; } catch { return null; }

    // Optional delegate
    if (data.delegateInscriptionId !== null && data.delegateInscriptionId !== undefined) {
      if (typeof data.delegateInscriptionId !== 'string') return null;
    }

    return data as CommitBundle;
  } catch {
    return null;
  }
}

export async function validateBundle(
  bundle: CommitBundle,
  userAddress: string
): Promise<BundleValidation> {
  const result: BundleValidation = {
    valid: false,
    commitUtxoExists: false,
    nameAvailable: false,
    nameUnlocked: false,
    currentHeight: 0,
    blocksUntilUnlock: 0,
    error: null,
    parentStatus: 'none',
  };

  try {
    result.currentHeight = await getCurrentBlockHeight();
    result.blocksUntilUnlock = Math.max(0, bundle.targetUnlockHeight - result.currentHeight);
    result.nameUnlocked = result.blocksUntilUnlock === 0;

    // Check commit UTXO
    const commitAddress = deriveCommitAddress(bundle);
    const utxos = await fetchUtxos(commitAddress);
    const commitUtxo = utxos.find(
      (u) => u.txid === bundle.commitTxid && u.vout === bundle.commitOutputIndex
    );
    result.commitUtxoExists = !!commitUtxo;

    if (!commitUtxo) {
      result.error = 'Commit UTXO has been spent. The locked funds are gone.';
      return result;
    }

    if (commitUtxo.value !== bundle.commitOutputValue) {
      result.error = `Commit output value mismatch. Expected ${bundle.commitOutputValue}, found ${commitUtxo.value}.`;
      return result;
    }

    // Check name
    result.nameAvailable = await checkRuneNameAvailable(bundle.runeName);
    if (!result.nameAvailable) {
      result.error = `Rune name "${bundle.runeName}" has already been etched.`;
      return result;
    }

    // Check parent (if any)
    if (bundle.parentInscriptionId) {
      const parentResult = await resolveParentForReveal(
        bundle.parentInscriptionId,
        userAddress
      );
      result.parentStatus = parentResult.status;
      if (parentResult.status === 'moved') {
        result.parentCurrentAddress = parentResult.currentAddress;
      } else if (parentResult.status === 'not-found') {
        result.error = parentResult.error;
      }
    }

    result.valid = result.commitUtxoExists && result.nameAvailable;
    return result;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    result.error = `Validation failed: ${message}`;
    return result;
  }
}

function bundleNetwork(bundle: CommitBundle): bitcoin.Network {
  if (bundle.network === 'testnet') return bitcoin.networks.testnet;
  if (bundle.network === 'signet') return bitcoin.networks.testnet; // signet uses testnet params
  return bitcoin.networks.bitcoin;
}

function deriveCommitAddress(bundle: CommitBundle): string {
  const internalPubkey = Buffer.from(bundle.internalPubkeyHex, 'hex');
  const tapscript = Buffer.from(bundle.tapscriptHex, 'hex');

  const { address } = bitcoin.payments.p2tr({
    internalPubkey,
    scriptTree: { output: tapscript },
    network: bundleNetwork(bundle),
  });

  if (!address) throw new Error('Failed to derive commit address from bundle');
  return address;
}

export function hydrateFromBundle(bundle: CommitBundle): {
  commitState: CommitTxState;
  etching: RuneEtching;
  inscriptionFile: InscriptionFile | null;
  parentInscriptionId: string | null;
  tapscript: Uint8Array;
  controlBlock: Buffer;
  internalPubkey: Buffer;
} {
  const commitState: CommitTxState = {
    txid: bundle.commitTxid,
    rawHex: '',
    confirmations: 0,
    changeAddress: '',
    commitOutputIndex: bundle.commitOutputIndex,
    commitOutputValue: bundle.commitOutputValue,
  };

  const etching: RuneEtching = {
    runeName: bundle.runeName,
    spacers: bundle.etching.spacers,
    symbol: bundle.etching.symbol,
    divisibility: bundle.etching.divisibility,
    premine: BigInt(bundle.etching.premine),
    terms: bundle.etching.terms
      ? {
          amount: BigInt(bundle.etching.terms.amount),
          cap: BigInt(bundle.etching.terms.cap),
          heightStart: bundle.etching.terms.heightStart,
          heightEnd: bundle.etching.terms.heightEnd,
          offsetStart: bundle.etching.terms.offsetStart,
          offsetEnd: bundle.etching.terms.offsetEnd,
        }
      : null,
    turbo: bundle.etching.turbo,
  };

  const inscriptionFile: InscriptionFile | null = bundle.inscriptionFile
    ? {
        contentType: bundle.inscriptionFile.contentType,
        body: base64ToUint8(bundle.inscriptionFile.bodyBase64),
      }
    : null;

  return {
    commitState,
    etching,
    inscriptionFile,
    parentInscriptionId: bundle.parentInscriptionId,
    tapscript: hexToBytes(bundle.tapscriptHex),
    controlBlock: Buffer.from(bundle.controlBlockHex, 'hex'),
    internalPubkey: Buffer.from(bundle.internalPubkeyHex, 'hex'),
  };
}

export async function refreshParentUtxo(
  parentInscriptionId: string,
  userAddress: string
): Promise<ParentInscription | null> {
  const result = await resolveParentForReveal(parentInscriptionId, userAddress);
  if (result.status === 'ready') return result.parent;
  return null;
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error(`Invalid hex in bundle: odd length (${hex.length})`);
  if (hex.length > 0 && !/^[0-9a-f]+$/i.test(hex)) throw new Error('Invalid hex in bundle: contains non-hex characters');
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

function base64ToUint8(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

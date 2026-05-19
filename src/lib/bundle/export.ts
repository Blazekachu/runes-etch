import type { CommitBundle, CommitTxState, RuneEtching, InscriptionFile } from '@/types';
import { computeUnlockHeight } from '@/lib/runes/names';

interface ExportParams {
  commitState: CommitTxState;
  runeName: string;
  tapscript: Uint8Array;
  controlBlock: Uint8Array;
  internalPubkey: Uint8Array;
  inscriptionFile: InscriptionFile | null;
  delegateInscriptionId: string | null;
  parentInscriptionId: string | null;
  etching: RuneEtching;
  /** Address used to detect network (mainnet bc1p/testnet tb1p/signet) */
  taprootAddress?: string;
}

export function createCommitBundle(params: ExportParams): CommitBundle {
  const {
    commitState, runeName, tapscript, controlBlock,
    internalPubkey, inscriptionFile, delegateInscriptionId, parentInscriptionId, etching,
    taprootAddress,
  } = params;

  const network = detectNetwork(taprootAddress);

  return {
    version: 1,
    type: 'runes-etch-commit',
    createdAt: new Date().toISOString(),
    network,
    commitTxid: commitState.txid,
    commitOutputIndex: commitState.commitOutputIndex,
    commitOutputValue: commitState.commitOutputValue,
    runeName,
    targetUnlockHeight: computeUnlockHeight(runeName),
    tapscriptHex: bytesToHex(tapscript),
    controlBlockHex: bytesToHex(controlBlock),
    internalPubkeyHex: bytesToHex(internalPubkey),
    inscriptionFile: inscriptionFile
      ? {
          contentType: inscriptionFile.contentType,
          bodyBase64: uint8ToBase64(inscriptionFile.body),
        }
      : null,
    delegateInscriptionId,
    parentInscriptionId,
    etching: {
      spacers: etching.spacers,
      symbol: etching.symbol,
      divisibility: etching.divisibility,
      premine: etching.premine.toString(),
      terms: etching.terms
        ? {
            amount: etching.terms.amount.toString(),
            cap: etching.terms.cap.toString(),
            heightStart: etching.terms.heightStart,
            heightEnd: etching.terms.heightEnd,
            offsetStart: etching.terms.offsetStart,
            offsetEnd: etching.terms.offsetEnd,
          }
        : null,
      turbo: etching.turbo,
    },
  };
}

export function isBundleDownloadMandatory(
  targetUnlockHeight: number,
  currentBlockHeight: number
): boolean {
  return targetUnlockHeight - currentBlockHeight > 50;
}

export function blocksUntilUnlock(
  targetUnlockHeight: number,
  currentBlockHeight: number
): number {
  return Math.max(0, targetUnlockHeight - currentBlockHeight);
}

export function downloadBundle(bundle: CommitBundle): void {
  const json = JSON.stringify(bundle, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const filename = `${bundle.runeName}_commit_${bundle.commitTxid.slice(0, 8)}.runes.json`;
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function detectNetwork(address?: string): 'mainnet' | 'testnet' | 'signet' {
  if (!address) return 'mainnet';
  if (address.startsWith('tb1p')) return 'testnet';
  if (address.startsWith('bcrt1p')) return 'signet';
  return 'mainnet';
}

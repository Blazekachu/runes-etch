import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type {
  BuildPhase, WalletState, RuneEtching, RuneTerms,
  InscriptionFile, ParentInscription, LabeledUtxo,
  VanityConfig, VanityProgress, CommitTxState, FeeRates, CommitBundle,
} from '@/types';
import { minimumAtHeight, runeNameToU128 } from '@/lib/runes/names';

// --- JSON serialization for BigInt and Uint8Array ---

function replacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') {
    return { __bigint__: value.toString() };
  }
  if (value instanceof Uint8Array) {
    let binary = '';
    for (let i = 0; i < value.length; i++) {
      binary += String.fromCharCode(value[i]);
    }
    return { __uint8array__: btoa(binary) };
  }
  return value;
}

function reviver(_key: string, value: unknown): unknown {
  if (typeof value === 'object' && value !== null) {
    const rec = value as Record<string, unknown>;
    if ('__bigint__' in rec && typeof rec.__bigint__ === 'string') {
      try { return BigInt(rec.__bigint__); } catch { return 0n; }
    }
    if ('__uint8array__' in rec && typeof rec.__uint8array__ === 'string') {
      try {
        const binary = atob(rec.__uint8array__);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
          bytes[i] = binary.charCodeAt(i);
        }
        return bytes;
      } catch { return new Uint8Array(0); }
    }
  }
  return value;
}

// --- Auto-detection: pure function, NOT in the store ---

export interface DetectedMode {
  mode: 'quick' | 'commit-reveal';
  reason: string;
}

export function detectEtchMode(params: {
  inscriptionFile: InscriptionFile | null;
  delegateInscriptionId: string | null;
  parentInscription: ParentInscription | null;
  runeName: string;
  currentBlockHeight: number;
  isTestnet: boolean;
}): DetectedMode {
  if (params.inscriptionFile || params.delegateInscriptionId) {
    return { mode: 'commit-reveal', reason: 'Inscription requires commit-reveal' };
  }
  if (params.parentInscription) {
    return { mode: 'commit-reveal', reason: 'Parent linkage requires commit-reveal' };
  }
  if (params.runeName && !params.isTestnet) {
    const minValue = minimumAtHeight(params.currentBlockHeight);
    if (minValue > 0n) {
      try {
        const nameValue = runeNameToU128(params.runeName);
        if (nameValue < minValue) {
          return { mode: 'commit-reveal', reason: 'Name not yet unlocked — commit protects against front-running' };
        }
      } catch { /* invalid name — let validation catch it */ }
    }
  }
  return { mode: 'quick', reason: 'All conditions met for single-TX etch' };
}

// --- Store interface ---

interface BuilderStore {
  // Phase
  phase: BuildPhase;
  setPhase: (phase: BuildPhase) => void;

  // Accordion sections
  openSections: Record<string, boolean>;
  toggleSection: (key: string) => void;
  setSection: (key: string, open: boolean) => void;

  // Auto-detected mode
  detectedMode: 'quick' | 'commit-reveal';
  detectedReason: string;
  redetect: () => void;

  // Block height
  currentBlockHeight: number;
  setCurrentBlockHeight: (h: number) => void;

  // Wallet
  wallet: WalletState;
  setWallet: (wallet: WalletState) => void;

  // Rune details
  etching: RuneEtching;
  updateEtching: (partial: Partial<RuneEtching>) => void;
  updateTerms: (partial: Partial<RuneTerms>) => void;

  // Inscription
  inscriptionFile: InscriptionFile | null;
  setInscriptionFile: (file: InscriptionFile | null) => void;
  delegateInscriptionId: string | null;
  setDelegateInscriptionId: (id: string | null) => void;
  parentInscription: ParentInscription | null;
  setParentInscription: (parent: ParentInscription | null) => void;

  // UTXOs
  utxos: LabeledUtxo[];
  setUtxos: (utxos: LabeledUtxo[]) => void;
  toggleUtxoSelection: (txid: string, vout: number) => void;
  selectedUtxos: () => LabeledUtxo[];
  changeAddress: () => string;

  // Fees
  feeRates: FeeRates | null;
  setFeeRates: (rates: FeeRates) => void;
  selectedFeeRate: number;
  setSelectedFeeRate: (rate: number) => void;

  // Vanity
  vanityConfig: VanityConfig;
  setVanityConfig: (config: VanityConfig) => void;
  vanityProgress: VanityProgress;
  setVanityProgress: (progress: VanityProgress) => void;
  vanityLocktime: number | null;
  setVanityLocktime: (v: number | null) => void;

  // Commit TX state
  commitState: CommitTxState | null;
  setCommitState: (state: CommitTxState) => void;
  updateCommitConfirmations: (confirmations: number) => void;

  // Cached tapscript data
  cachedTapscriptHex: string | null;
  cachedControlBlockHex: string | null;
  cachedInternalPubkeyHex: string | null;
  setCachedTapscript: (tapscript: string, controlBlock: string, pubkey: string) => void;

  // Bundle
  bundleDownloaded: boolean;
  setBundleDownloaded: (v: boolean) => void;

  // TX results
  revealTxid: string | null;
  setRevealTxid: (txid: string) => void;
  quickTxid: string | null;
  setQuickTxid: (txid: string) => void;

  // Bundle resume
  loadFromBundle: (bundle: CommitBundle) => void;

  // Reset
  reset: () => void;
}

// --- Defaults ---

const defaultEtching: RuneEtching = {
  runeName: '',
  spacers: 0,
  symbol: '',
  divisibility: 0,
  premine: 0n,
  terms: null,
  turbo: false,
};

const defaultVanityProgress: VanityProgress = {
  attempts: 0,
  speed: 0,
  bestMatch: '',
  found: false,
  nonce: null,
};

const defaultOpenSections: Record<string, boolean> = {
  'rune-details': true,
  'fee-rate': true,
  'mint-terms': false,
  'inscription': false,
  'parent': false,
  'vanity': false,
  'utxo-select': false,
};

// --- Store ---

export const useBuilderStore = create<BuilderStore>()(
  persist(
    (set, get) => ({
      phase: 'building' as BuildPhase,
      setPhase: (phase) => set({ phase }),

      openSections: { ...defaultOpenSections },
      toggleSection: (key) => set((state) => ({
        openSections: { ...state.openSections, [key]: !state.openSections[key] },
      })),
      setSection: (key, open) => set((state) => ({
        openSections: { ...state.openSections, [key]: open },
      })),

      detectedMode: 'quick' as const,
      detectedReason: 'All conditions met for single-TX etch',
      redetect: () => {
        const s = get();
        const isTestnet = s.wallet.taprootAddress.startsWith('tb1') || s.wallet.paymentAddress.startsWith('tb1');
        const result = detectEtchMode({
          inscriptionFile: s.inscriptionFile,
          delegateInscriptionId: s.delegateInscriptionId,
          parentInscription: s.parentInscription,
          runeName: s.etching.runeName,
          currentBlockHeight: s.currentBlockHeight,
          isTestnet,
        });
        set({ detectedMode: result.mode, detectedReason: result.reason });
      },

      currentBlockHeight: 0,
      setCurrentBlockHeight: (h) => set({ currentBlockHeight: h }),

      wallet: { connected: false, taprootAddress: '', paymentAddress: '', publicKey: '' },
      setWallet: (wallet) => set({ wallet }),

      etching: { ...defaultEtching },
      updateEtching: (partial) => set((state) => ({ etching: { ...state.etching, ...partial } })),
      updateTerms: (partial) => set((state) => ({
        etching: {
          ...state.etching,
          terms: state.etching.terms
            ? { ...state.etching.terms, ...partial }
            : {
                amount: 0n,
                cap: 0n,
                heightStart: null,
                heightEnd: null,
                offsetStart: null,
                offsetEnd: null,
                ...partial,
              },
        },
      })),

      inscriptionFile: null,
      setInscriptionFile: (file) => set({ inscriptionFile: file }),
      delegateInscriptionId: null,
      setDelegateInscriptionId: (id) => set({ delegateInscriptionId: id }),
      parentInscription: null,
      setParentInscription: (parent) => set({ parentInscription: parent }),

      utxos: [],
      setUtxos: (utxos) => set({ utxos }),
      toggleUtxoSelection: (txid, vout) => set((state) => ({
        utxos: state.utxos.map((u) =>
          u.txid === txid && u.vout === vout ? { ...u, selected: !u.selected } : u
        ),
      })),
      selectedUtxos: () => get().utxos.filter((u) => u.selected),
      changeAddress: () => {
        const w = get().wallet;
        return w.paymentAddress || w.taprootAddress;
      },

      feeRates: null,
      setFeeRates: (rates) => set({ feeRates: rates }),
      selectedFeeRate: 10,
      setSelectedFeeRate: (rate) => set({ selectedFeeRate: rate }),

      vanityConfig: { prefix: '', suffix: '' },
      setVanityConfig: (config) => set({ vanityConfig: config }),
      vanityProgress: { ...defaultVanityProgress },
      setVanityProgress: (progress) => set({ vanityProgress: progress }),
      vanityLocktime: null,
      setVanityLocktime: (v) => set({ vanityLocktime: v }),

      commitState: null,
      setCommitState: (state) => set({ commitState: state }),
      updateCommitConfirmations: (confirmations) => set((state) => ({
        commitState: state.commitState ? { ...state.commitState, confirmations } : null,
      })),

      cachedTapscriptHex: null,
      cachedControlBlockHex: null,
      cachedInternalPubkeyHex: null,
      setCachedTapscript: (tapscript, controlBlock, pubkey) => set({
        cachedTapscriptHex: tapscript,
        cachedControlBlockHex: controlBlock,
        cachedInternalPubkeyHex: pubkey,
      }),

      bundleDownloaded: false,
      setBundleDownloaded: (v) => set({ bundleDownloaded: v }),

      revealTxid: null,
      setRevealTxid: (txid) => set({ revealTxid: txid }),
      quickTxid: null,
      setQuickTxid: (txid) => set({ quickTxid: txid }),

      loadFromBundle: (bundle) => {
        set({
          phase: 'waiting',
          detectedMode: 'commit-reveal',
          detectedReason: 'Resumed from commit bundle',
          etching: {
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
          },
          commitState: {
            txid: bundle.commitTxid,
            rawHex: '',
            confirmations: 0,
            commitOutputIndex: bundle.commitOutputIndex,
            commitOutputValue: bundle.commitOutputValue,
            changeAddress: '',
          },
          delegateInscriptionId: bundle.delegateInscriptionId ?? null,
          parentInscription: null,
          bundleDownloaded: true,
          cachedTapscriptHex: bundle.tapscriptHex,
          cachedControlBlockHex: bundle.controlBlockHex,
          cachedInternalPubkeyHex: bundle.internalPubkeyHex,
          vanityConfig: { prefix: '', suffix: '' },
          vanityProgress: { ...defaultVanityProgress },
          vanityLocktime: null,
        });
      },

      reset: () => set({
        phase: 'building',
        openSections: { ...defaultOpenSections },
        detectedMode: 'quick',
        detectedReason: 'All conditions met for single-TX etch',
        currentBlockHeight: 0,
        wallet: { connected: false, taprootAddress: '', paymentAddress: '', publicKey: '' },
        etching: { ...defaultEtching },
        inscriptionFile: null,
        delegateInscriptionId: null,
        parentInscription: null,
        utxos: [],
        feeRates: null,
        selectedFeeRate: 10,
        vanityConfig: { prefix: '', suffix: '' },
        vanityProgress: { ...defaultVanityProgress },
        vanityLocktime: null,
        commitState: null,
        bundleDownloaded: false,
        revealTxid: null,
        quickTxid: null,
        cachedTapscriptHex: null,
        cachedControlBlockHex: null,
        cachedInternalPubkeyHex: null,
      }),
    }),
    {
      name: 'runes-etch-v2-store',
      partialize: (state) => ({
        phase: state.phase,
        openSections: state.openSections,
        detectedMode: state.detectedMode,
        detectedReason: state.detectedReason,
        currentBlockHeight: state.currentBlockHeight,
        wallet: { connected: state.wallet.connected, taprootAddress: state.wallet.taprootAddress, paymentAddress: state.wallet.paymentAddress, publicKey: '' },
        etching: state.etching,
        inscriptionFile: state.inscriptionFile,
        delegateInscriptionId: state.delegateInscriptionId,
        parentInscription: state.parentInscription,
        commitState: state.commitState ? { txid: state.commitState.txid, rawHex: '', confirmations: state.commitState.confirmations, commitOutputIndex: state.commitState.commitOutputIndex, commitOutputValue: state.commitState.commitOutputValue, changeAddress: state.commitState.changeAddress } : null,
        vanityConfig: state.vanityConfig,
        vanityLocktime: state.vanityLocktime,
        selectedFeeRate: state.selectedFeeRate,
        cachedTapscriptHex: state.cachedTapscriptHex,
        cachedControlBlockHex: state.cachedControlBlockHex,
        cachedInternalPubkeyHex: state.cachedInternalPubkeyHex,
        revealTxid: state.revealTxid,
        quickTxid: state.quickTxid,
      }),
      storage: createJSONStorage(() => localStorage, { replacer, reviver }),
    }
  )
);

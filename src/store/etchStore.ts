import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type {
  EtchMode, WizardStep, WalletState, RuneEtching, RuneTerms,
  InscriptionFile, ParentInscription, LabeledUtxo,
  VanityConfig, VanityProgress, CommitTxState, FeeRates, CommitBundle,
} from '@/types';

/** Max age of a persisted wallet connection before it's discarded on page load. */
const WALLET_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DISCONNECTED_WALLET: WalletState = { connected: false, taprootAddress: '', paymentAddress: '', publicKey: '' };

// JSON serialization for BigInt and Uint8Array.
// BigInt → {"__bigint__": "123"}, Uint8Array → {"__uint8array__": "base64..."}
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
  // H8: try/catch prevents corrupted localStorage from crashing the entire app
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

interface EtchStore {
  // Mode
  etchMode: EtchMode;
  setEtchMode: (mode: EtchMode) => void;

  // Wizard navigation
  step: WizardStep;
  setStep: (step: WizardStep) => void;

  // Wallet
  wallet: WalletState;
  setWallet: (wallet: WalletState) => void;
  /** Unix ms when wallet was last connected. Drives the 7-day auto-reconnect TTL. */
  connectedAt: number | null;

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
  /** Returns the address that change should go to based on selected UTXO sources */
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

  // Cached tapscript data (from commit or bundle — used for reveal)
  cachedTapscriptHex: string | null;
  cachedControlBlockHex: string | null;
  cachedInternalPubkeyHex: string | null;
  setCachedTapscript: (tapscript: string, controlBlock: string, pubkey: string) => void;

  // Bundle
  bundleDownloaded: boolean;
  setBundleDownloaded: (v: boolean) => void;

  // Reveal TX
  revealTxid: string | null;
  setRevealTxid: (txid: string) => void;

  // Bundle resume
  loadFromBundle: (bundle: CommitBundle) => void;

  // Reset
  reset: () => void;
}

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

export const useEtchStore = create<EtchStore>()(
  persist(
    (set, get) => ({
      etchMode: 'full' as EtchMode,
      // H1: Lock etchMode after commit to prevent tapscript mismatch
      setEtchMode: (mode) => {
        if (get().commitState) return; // locked after commit
        set({ etchMode: mode });
      },

      step: 'connect' as WizardStep,
      setStep: (step) => set({ step }),

      wallet: { connected: false, taprootAddress: '', paymentAddress: '', publicKey: '' },
      connectedAt: null,
      setWallet: (wallet) => set({ wallet, connectedAt: wallet.connected ? Date.now() : null }),

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
        // Change always goes to payment address. Taproot is reserved for
        // inscriptions and runes only — keeps the address clean.
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

      cachedTapscriptHex: null,
      cachedControlBlockHex: null,
      cachedInternalPubkeyHex: null,
      setCachedTapscript: (tapscript, controlBlock, pubkey) => set({
        cachedTapscriptHex: tapscript,
        cachedControlBlockHex: controlBlock,
        cachedInternalPubkeyHex: pubkey,
      }),

      commitState: null,
      setCommitState: (state) => set({ commitState: state }),
      updateCommitConfirmations: (confirmations) => set((state) => ({
        commitState: state.commitState ? { ...state.commitState, confirmations } : null,
      })),

      bundleDownloaded: false,
      setBundleDownloaded: (v) => set({ bundleDownloaded: v }),

      revealTxid: null,
      setRevealTxid: (txid) => set({ revealTxid: txid }),

      loadFromBundle: (bundle) => {
        const hasInscription = !!bundle.inscriptionFile || !!bundle.delegateInscriptionId;
        const hasParent = !!bundle.parentInscriptionId;
        set({
          step: 'waiting',
          etchMode: hasInscription ? (hasParent ? 'full' : 'no-parent') : 'no-inscription',
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
          parentInscription: null, // re-resolved at reveal time
          bundleDownloaded: true,
          // Cache tapscript data from bundle so reveal doesn't need to recompute
          cachedTapscriptHex: bundle.tapscriptHex,
          cachedControlBlockHex: bundle.controlBlockHex,
          cachedInternalPubkeyHex: bundle.internalPubkeyHex,
          // Reset vanity state — old values are for a different TX
          vanityConfig: { prefix: '', suffix: '' },
          vanityProgress: { ...defaultVanityProgress },
          vanityLocktime: null,
        });
      },

      reset: () => set({
        etchMode: 'full',
        step: 'connect',
        wallet: { connected: false, taprootAddress: '', paymentAddress: '', publicKey: '' },
        connectedAt: null,
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
        cachedTapscriptHex: null,
        cachedControlBlockHex: null,
        cachedInternalPubkeyHex: null,
      }),
    }),
    {
      name: 'runes-etch-store',
      version: 2,
      migrate: (persisted) => persisted as EtchStore,
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        const fresh = state.connectedAt && Date.now() - state.connectedAt < WALLET_SESSION_TTL_MS;
        if (!fresh) {
          state.wallet = DISCONNECTED_WALLET;
          state.connectedAt = null;
          // Bounce back to the connect step — there's no point sitting on a later wizard step
          // with no wallet and a stale form.
          state.step = 'connect';
        }
      },
      // Only persist fields needed for session recovery.
      // etching contains BigInt (premine); handled via replacer/reviver below.
      partialize: (state) => ({
        step: state.step,
        etchMode: state.etchMode,
        // Persist full wallet (publicKey included — it's public data, needed for signing).
        // TTL expiry enforced in onRehydrateStorage via WALLET_SESSION_TTL_MS.
        wallet: state.wallet,
        connectedAt: state.connectedAt,
        etching: state.etching,
        // H1: Persist inscription file so page refresh during waiting doesn't lose it.
        // body is Uint8Array — JSON serialized as number array by default, revived on load.
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
      }),
      storage: createJSONStorage(() => localStorage, { replacer, reviver }),
    }
  )
);

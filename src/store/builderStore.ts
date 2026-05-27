import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type {
  BuildPhase, WalletState, RuneEtching, RuneTerms,
  InscriptionFile, ParentInscription, LabeledUtxo,
  VanityConfig, VanityProgress, CommitTxState, FeeRates, CommitBundle,
  UtxoSatInfo, SatRarity,
} from '@/types';

/** Tier ranking for auto-primary fallback — picks rarer over more-common when no explicit primary. */
const RARITY_RANK: Record<SatRarity, number> = {
  common: 0, uncommon: 1, rare: 2, epic: 3, legendary: 4, mythic: 5,
};

/** Resolved target UTXO from a sat# / inscription ID lookup. Becomes vin[0]. */
export interface TargetUtxo {
  txid: string;
  vout: number;
  value: number;
  /** The sat# user targeted (must be at offset 0 of this UTXO for the etch to land on it). */
  satNumber: number;
  /** Inscription IDs already on this UTXO (empty for plain target). Presence → auto reinscription. */
  inscriptionIds: string[];
  /** Rune names on this UTXO. Empty for plain. Non-empty + no inscriptions → user is stacking on a rune UTXO (allowed; new rune lands on the same UTXO). */
  runeNames: string[];
}
import { minimumAtHeight, runeNameToU128 } from '@/lib/runes/names';

/** Max age of a persisted wallet connection before it's discarded on page load. */
const WALLET_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DISCONNECTED_WALLET: WalletState = { connected: false, taprootAddress: '', paymentAddress: '', publicKey: '' };

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
  /** Authoritative chain rune-name minimum (e.g. from ord). When set, used regardless
   *  of network. Without it, mainnet falls back to local `minimumAtHeight()` and
   *  testnet is permissive (legacy behavior — Finding #11). */
  runeMinimum: bigint | null;
}): DetectedMode {
  if (params.inscriptionFile || params.delegateInscriptionId) {
    return { mode: 'commit-reveal', reason: 'Inscription requires commit-reveal' };
  }
  if (params.parentInscription) {
    return { mode: 'commit-reveal', reason: 'Parent linkage requires commit-reveal' };
  }
  if (params.runeName) {
    let minValue: bigint | null = null;
    if (params.runeMinimum !== null) {
      minValue = params.runeMinimum;
    } else if (!params.isTestnet) {
      minValue = minimumAtHeight(params.currentBlockHeight);
    }
    if (minValue !== null && minValue > 0n) {
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

  /**
   * Chain's current rune-name minimum from ord (`/status.minimum_rune_for_next_block`,
   * converted to u128). Authoritative for whichever chain ord is configured to.
   * `null` when ord is unreachable or we haven't fetched yet. Not persisted —
   * refetched each session because it advances with the chain.
   *
   * Used by validateRuneName + buildQuickEtchTx to fix Finding #11 (testnet4
   * silent cenotaph on below-minimum quick etches).
   */
  runeMinimum: bigint | null;
  setRuneMinimum: (m: bigint | null) => void;

  // Wallet
  wallet: WalletState;
  setWallet: (wallet: WalletState) => void;
  /** Unix ms when wallet was last connected. Used to expire auto-reconnect after WALLET_SESSION_TTL_MS. */
  connectedAt: number | null;

  /** Parent inscription ID carried in from a bundle resume; ParentSection re-resolves it to a live UTXO. */
  pendingParentId: string | null;
  setPendingParentId: (id: string | null) => void;

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
  /**
   * Explicit "primary" UTXO id (`txid:vout`) — becomes vin 0 of the commit / quick TX.
   * Inscriptions land on the first sat of vin 0, so the primary UTXO controls which sat
   * receives the etch. null = no explicit choice (UI auto-falls-back to the largest
   * selected via `effectivePrimaryUtxoId`).
   */
  primaryUtxoId: string | null;
  setPrimaryUtxoId: (id: string | null) => void;
  /** Effective primary: explicit if set + still selected; otherwise largest selected; else null. */
  effectivePrimaryUtxoId: () => string | null;
  /** Selected UTXOs ordered with effective primary first — pass this to TX builders. */
  orderedFundingUtxos: () => LabeledUtxo[];

  /**
   * Reinscribe mode: when ON, inscription-labeled UTXOs become selectable. The selected
   * inscription UTXO is forced as primary so its sat (which holds the original inscription)
   * becomes vin 0 → the new inscription stacks on the same sat in ord's index.
   * Rune-labeled UTXOs remain blocked — rune burn protection.
   */
  reinscribeMode: boolean;
  setReinscribeMode: (on: boolean) => void;

  // --- Target sat / inscription (manual entry, sidesteps taproot enumeration) ---
  // For users with hoarder taproot addresses where /utxo + /txs walk fail or are
  // unbearably slow, this lets them name a specific sat# or inscription ID. The
  // builder verifies via a single ord lookup (no enumeration) and uses the resolved
  // UTXO as vin[0]. When verified, it overrides any picker-selected primary.
  targetInput: string;
  setTargetInput: (v: string) => void;
  targetUtxo: TargetUtxo | null;
  setTargetUtxo: (u: TargetUtxo | null) => void;
  targetVerifyState: 'idle' | 'verifying' | 'ok' | 'error';
  setTargetVerifyState: (s: 'idle' | 'verifying' | 'ok' | 'error') => void;
  targetVerifyError: string;
  setTargetVerifyError: (e: string) => void;
  /**
   * Cached rarity info per UTXO (key = `txid:vout`). Populated async after UTXO list loads
   * (mainnet only). UTXOs not in the map are either still loading or ord didn't return data
   * for them. Not persisted — refetched per session since UTXOs change.
   */
  utxoSatInfo: Record<string, UtxoSatInfo>;
  setUtxoSatInfo: (info: Record<string, UtxoSatInfo>) => void;
  mergeUtxoSatInfo: (info: Record<string, UtxoSatInfo>) => void;

  // Fees
  feeRates: FeeRates | null;
  setFeeRates: (rates: FeeRates) => void;
  /** Commit fee rate (sat/vB). The user's selected rate for the commit TX. Also used as fallback for selectedRevealFeeRate. */
  selectedFeeRate: number;
  setSelectedFeeRate: (rate: number) => void;
  /**
   * Reveal fee rate budget (sat/vB). The MAX rate the reveal can pay — controls how
   * many sats the commit pre-allocates to commit.vout[0]. At reveal sign time the user
   * can pick any rate from 1 up to this value; difference returns to payment as change.
   * Falls back to selectedFeeRate when null (back-compat with old bundles).
   */
  selectedRevealFeeRate: number | null;
  setSelectedRevealFeeRate: (rate: number | null) => void;

  // Vanity — these existing fields apply to the REVEAL TX in commit-reveal mode,
  // and to the single TX in quick mode. Renaming would be more invasive; the new
  // commit-vanity fields below are explicitly named for clarity.
  vanityConfig: VanityConfig;
  setVanityConfig: (config: VanityConfig) => void;
  vanityProgress: VanityProgress;
  setVanityProgress: (progress: VanityProgress) => void;
  vanityLocktime: number | null;
  setVanityLocktime: (v: number | null) => void;
  /** Commit-TXID vanity config — applies only in commit-reveal mode. Grinds before signing the commit. */
  commitVanityConfig: VanityConfig;
  setCommitVanityConfig: (config: VanityConfig) => void;
  commitVanityProgress: VanityProgress;
  setCommitVanityProgress: (progress: VanityProgress) => void;
  /** Found nLockTime for the commit. Set when grinder succeeds; consumed by BuildButton at sign time. */
  commitVanityLocktime: number | null;
  setCommitVanityLocktime: (v: number | null) => void;

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
          runeMinimum: s.runeMinimum,
        });
        set({ detectedMode: result.mode, detectedReason: result.reason });
      },

      currentBlockHeight: 0,
      setCurrentBlockHeight: (h) => set({ currentBlockHeight: h }),

      runeMinimum: null,
      setRuneMinimum: (m) => set({ runeMinimum: m }),

      wallet: { connected: false, taprootAddress: '', paymentAddress: '', publicKey: '' },
      connectedAt: null,
      setWallet: (wallet) => set({ wallet, connectedAt: wallet.connected ? Date.now() : null }),

      pendingParentId: null,
      setPendingParentId: (id) => set({ pendingParentId: id }),

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
      toggleUtxoSelection: (txid, vout) => set((state) => {
        const id = `${txid}:${vout}`;
        const u = state.utxos.find((x) => x.txid === txid && x.vout === vout);
        const isInscription = u?.label === 'inscription';
        const willBeSelected = !u?.selected;
        // If the user is deselecting the explicit primary, clear it.
        const clearPrimary = state.primaryUtxoId === id;
        // In reinscribe mode, selecting an inscription UTXO auto-promotes it to primary
        // (overriding any previous primary). This guarantees the inscribed sat ends up at
        // vin 0 of the commit TX, which is required for the stacking to work in ord.
        const autoPrimary = state.reinscribeMode && isInscription && willBeSelected;
        return {
          utxos: state.utxos.map((x) =>
            x.txid === txid && x.vout === vout ? { ...x, selected: !x.selected } : x
          ),
          ...(autoPrimary ? { primaryUtxoId: id } : clearPrimary ? { primaryUtxoId: null } : {}),
        };
      }),
      selectedUtxos: () => get().utxos.filter((u) => u.selected),
      changeAddress: () => {
        const w = get().wallet;
        return w.paymentAddress || w.taprootAddress;
      },

      primaryUtxoId: null,
      setPrimaryUtxoId: (id) => set({ primaryUtxoId: id }),
      effectivePrimaryUtxoId: () => {
        const selected = get().utxos.filter((u) => u.selected);
        if (selected.length === 0) return null;
        const explicit = get().primaryUtxoId;
        if (explicit && selected.some((u) => `${u.txid}:${u.vout}` === explicit)) {
          return explicit;
        }
        // Auto-fallback: prefer the rarest (highest tier) non-common selected UTXO.
        // If user selects a small rare-sat UTXO + a large fee UTXO without marking primary,
        // this avoids accidentally auto-promoting the fee UTXO and wasting the inscription
        // opportunity on a common sat. Tie-break by largest value within the same rarity tier.
        const satInfo = get().utxoSatInfo;
        let bestRare: { u: LabeledUtxo; rank: number } | null = null;
        for (const u of selected) {
          const info = satInfo[`${u.txid}:${u.vout}`];
          if (!info || info.rarity === 'common') continue;
          const rank = RARITY_RANK[info.rarity];
          if (
            !bestRare ||
            rank > bestRare.rank ||
            (rank === bestRare.rank && u.value > bestRare.u.value)
          ) {
            bestRare = { u, rank };
          }
        }
        if (bestRare) return `${bestRare.u.txid}:${bestRare.u.vout}`;
        // No non-common rarity info available — fall back to largest selected.
        let largest = selected[0];
        for (const u of selected) if (u.value > largest.value) largest = u;
        return `${largest.txid}:${largest.vout}`;
      },
      orderedFundingUtxos: () => {
        const selected = get().utxos.filter((u) => u.selected);
        if (selected.length === 0) return [];
        const primaryId = get().effectivePrimaryUtxoId();
        if (!primaryId) return selected;
        const idx = selected.findIndex((u) => `${u.txid}:${u.vout}` === primaryId);
        if (idx <= 0) return selected;
        return [selected[idx], ...selected.slice(0, idx), ...selected.slice(idx + 1)];
      },

      utxoSatInfo: {},
      setUtxoSatInfo: (info) => set({ utxoSatInfo: info }),
      mergeUtxoSatInfo: (info) => set((state) => ({ utxoSatInfo: { ...state.utxoSatInfo, ...info } })),

      reinscribeMode: false,
      setReinscribeMode: (on) => set((state) => ({
        reinscribeMode: on,
        // Turning OFF reinscribe mode while an inscription UTXO is selected/primary would leave
        // the user with an "unselectable but selected" state. Clear those.
        ...(on ? {} : {
          utxos: state.utxos.map((u) => u.label === 'inscription' && u.selected ? { ...u, selected: false } : u),
          primaryUtxoId: state.utxos.some((u) => u.label === 'inscription' && `${u.txid}:${u.vout}` === state.primaryUtxoId) ? null : state.primaryUtxoId,
        }),
      })),

      targetInput: '',
      setTargetInput: (v) => set({ targetInput: v }),
      targetUtxo: null,
      setTargetUtxo: (u) => set((state) => ({
        targetUtxo: u,
        // Auto-enable reinscribeMode when target carries an inscription. The build
        // path is identical (target becomes vin[0]) but this flag lets the runestone
        // builder / UI know the new etch is stacking on existing inscription data.
        reinscribeMode: u ? u.inscriptionIds.length > 0 : state.reinscribeMode,
      })),
      targetVerifyState: 'idle',
      setTargetVerifyState: (s) => set({ targetVerifyState: s }),
      targetVerifyError: '',
      setTargetVerifyError: (e) => set({ targetVerifyError: e }),

      feeRates: null,
      setFeeRates: (rates) => set({ feeRates: rates }),
      selectedFeeRate: 10,
      setSelectedFeeRate: (rate) => set({ selectedFeeRate: rate }),
      selectedRevealFeeRate: null,
      setSelectedRevealFeeRate: (rate) => set({ selectedRevealFeeRate: rate }),

      vanityConfig: { prefix: '', suffix: '' },
      setVanityConfig: (config) => set({ vanityConfig: config }),
      vanityProgress: { ...defaultVanityProgress },
      setVanityProgress: (progress) => set({ vanityProgress: progress }),
      vanityLocktime: null,
      setVanityLocktime: (v) => set({ vanityLocktime: v }),
      commitVanityConfig: { prefix: '', suffix: '' },
      setCommitVanityConfig: (config) => set({ commitVanityConfig: config }),
      commitVanityProgress: { ...defaultVanityProgress },
      setCommitVanityProgress: (progress) => set({ commitVanityProgress: progress }),
      commitVanityLocktime: null,
      setCommitVanityLocktime: (v) => set({ commitVanityLocktime: v }),

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
        // Decode the inscription body so UI sections (InscriptionSection) can display it.
        // The reveal itself uses cachedTapscriptHex, which already has the body baked in —
        // this is purely for display fidelity on resume.
        let inscriptionFile: InscriptionFile | null = null;
        if (bundle.inscriptionFile) {
          const binary = atob(bundle.inscriptionFile.bodyBase64);
          const body = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) body[i] = binary.charCodeAt(i);
          inscriptionFile = { contentType: bundle.inscriptionFile.contentType, body };
        }

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
          inscriptionFile,
          delegateInscriptionId: bundle.delegateInscriptionId ?? null,
          // Parent UTXO data is intentionally not in the bundle (volatile). Carry the ID forward;
          // ParentSection re-resolves it to a live UTXO via ordinals.com / mempool on mount.
          parentInscription: null,
          pendingParentId: bundle.parentInscriptionId ?? null,
          bundleDownloaded: true,
          cachedTapscriptHex: bundle.tapscriptHex,
          cachedControlBlockHex: bundle.controlBlockHex,
          cachedInternalPubkeyHex: bundle.internalPubkeyHex,
          vanityConfig: { prefix: '', suffix: '' },
          vanityProgress: { ...defaultVanityProgress },
          vanityLocktime: null,
          // Carry the reveal-fee budget from the bundle so WaitingPhase can cap the
          // reveal fee selector at what the commit actually pre-funded. Null = unknown
          // (pre-feature bundles); reveal can pay up to whatever commit.vout[0] allows.
          selectedRevealFeeRate: bundle.revealFeeRateBudget ?? null,
        });
      },

      reset: () => set({
        phase: 'building',
        openSections: { ...defaultOpenSections },
        detectedMode: 'quick',
        detectedReason: 'All conditions met for single-TX etch',
        currentBlockHeight: 0,
        runeMinimum: null,
        wallet: { connected: false, taprootAddress: '', paymentAddress: '', publicKey: '' },
        etching: { ...defaultEtching },
        inscriptionFile: null,
        delegateInscriptionId: null,
        parentInscription: null,
        pendingParentId: null,
        utxos: [],
        primaryUtxoId: null,
        utxoSatInfo: {},
        reinscribeMode: false,
        targetInput: '',
        targetUtxo: null,
        targetVerifyState: 'idle' as const,
        targetVerifyError: '',
        feeRates: null,
        selectedFeeRate: 10,
        selectedRevealFeeRate: null,
        vanityConfig: { prefix: '', suffix: '' },
        vanityProgress: { ...defaultVanityProgress },
        vanityLocktime: null,
        commitVanityConfig: { prefix: '', suffix: '' },
        commitVanityProgress: { ...defaultVanityProgress },
        commitVanityLocktime: null,
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
      version: 2,
      // No-op migrate: returning the persisted state as-is lets Zustand merge unknown fields
      // (older snapshots without pendingParentId, etc.) with the current initial state defaults
      // instead of logging a "couldn't be migrated" warning and discarding everything.
      migrate: (persisted) => persisted as BuilderStore,
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        const fresh = state.connectedAt && Date.now() - state.connectedAt < WALLET_SESSION_TTL_MS;
        if (!fresh) {
          state.wallet = DISCONNECTED_WALLET;
          state.connectedAt = null;
        }
      },
      partialize: (state) => ({
        phase: state.phase,
        openSections: state.openSections,
        detectedMode: state.detectedMode,
        detectedReason: state.detectedReason,
        currentBlockHeight: state.currentBlockHeight,
        // Wallet auto-reconnect: persist full wallet (publicKey included — it's public).
        // Expiry is enforced in onRehydrateStorage via WALLET_SESSION_TTL_MS.
        wallet: state.wallet,
        connectedAt: state.connectedAt,
        etching: state.etching,
        inscriptionFile: state.inscriptionFile,
        delegateInscriptionId: state.delegateInscriptionId,
        parentInscription: state.parentInscription,
        pendingParentId: state.pendingParentId,
        primaryUtxoId: state.primaryUtxoId,
        reinscribeMode: state.reinscribeMode,
        targetInput: state.targetInput,
        targetUtxo: state.targetUtxo,
        targetVerifyState: state.targetVerifyState,
        targetVerifyError: state.targetVerifyError,
        commitState: state.commitState ? { txid: state.commitState.txid, rawHex: '', confirmations: state.commitState.confirmations, commitOutputIndex: state.commitState.commitOutputIndex, commitOutputValue: state.commitState.commitOutputValue, changeAddress: state.commitState.changeAddress } : null,
        vanityConfig: state.vanityConfig,
        vanityLocktime: state.vanityLocktime,
        commitVanityConfig: state.commitVanityConfig,
        commitVanityLocktime: state.commitVanityLocktime,
        selectedFeeRate: state.selectedFeeRate,
        selectedRevealFeeRate: state.selectedRevealFeeRate,
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

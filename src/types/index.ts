// --- Etching Modes ---

export type EtchMode = 'full' | 'no-parent' | 'no-inscription' | 'quick';

// --- Builder v2 Phase ---

export type BuildPhase = 'building' | 'waiting' | 'reveal' | 'complete';

// --- Rune Etching Types ---

export interface RuneEtching {
  runeName: string;
  spacers: number;
  symbol: string;
  divisibility: number;
  premine: bigint;
  terms: RuneTerms | null;
  turbo: boolean;
}

export interface RuneTerms {
  amount: bigint;
  cap: bigint;
  heightStart: number | null;
  heightEnd: number | null;
  offsetStart: number | null;
  offsetEnd: number | null;
}

export interface RunestoneData {
  etching: RuneEtching;
  pointer: number | null;
  nonce: Uint8Array;
}

// --- Inscription Types ---

export interface InscriptionFile {
  contentType: string;
  body: Uint8Array;
}

export const MAX_INSCRIPTION_SIZE = 350 * 1024; // 350KB — matches Inscription.tsx enforcement

export interface ParentInscription {
  inscriptionId: string;
  txid: string;
  vout: number;
  value: number;
  address: string; // current address holding the parent
}

// --- UTXO Types ---

export interface Utxo {
  txid: string;
  vout: number;
  value: number;
  status: {
    confirmed: boolean;
    block_height?: number;
  };
}

export interface LabeledUtxo extends Utxo {
  label: 'plain' | 'inscription' | 'rune' | 'unknown';
  selected: boolean;
  source: 'taproot' | 'payment';
  /** Inscription IDs on this UTXO (populated when label === 'inscription'). Used by reinscribe flow. */
  inscriptionIds?: string[];
}

// --- Fee Types ---

export interface FeeRates {
  fastestFee: number;
  halfHourFee: number;
  hourFee: number;
  economyFee: number;
  minimumFee: number;
  /** Set when fee environment is anomalously high */
  _feeWarning?: string;
}

// --- Vanity Types ---

export interface VanityConfig {
  prefix: string;
  suffix: string;
}

export interface VanityProgress {
  attempts: number;
  speed: number;
  bestMatch: string;
  found: boolean;
  nonce: Uint8Array | null;
}

// --- Wizard State ---

export type WizardStep =
  | 'connect'
  | 'rune-details'
  | 'mint-terms'
  | 'inscription'
  | 'utxo-select'
  | 'vanity-fees'
  | 'review'
  | 'waiting'
  | 'reveal'
  | 'quick-review';

export interface CommitTxState {
  txid: string;
  rawHex: string;
  confirmations: number;
  commitOutputIndex: number;
  commitOutputValue: number;
  /** M4: Change address locked at commit time so reveal uses correct address even if UTXOs change */
  changeAddress: string;
}

export interface RevealTxState {
  txid: string;
  rawHex: string;
  vanityNonce: Uint8Array;
}

// --- Wallet Types ---

export interface WalletState {
  connected: boolean;
  taprootAddress: string;
  paymentAddress: string;
  publicKey: string;
}

// --- API Response Types ---

export interface OrdRuneResponse {
  id: string;
  name: string;
  spacedName: string;
  number: number;
}

export interface OrdInscriptionResponse {
  id: string;
  address: string;
  output: string;
  content_type: string;
}

export interface OrdOutputResponse {
  address: string;
  inscriptions: string[];
  runes: Record<string, { amount: number; divisibility: number }>;
  value: number;
  /** Ord-style array of [start, end) sat ranges. First sat of the output = sat_ranges[0][0]. */
  sat_ranges?: Array<[number, number]>;
}

export type SatRarity = 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary' | 'mythic';

export interface OrdSatResponse {
  number: number;
  rarity: SatRarity;
  name: string;
  block: number;
  cycle: number;
  epoch: number;
  period: number;
  decimal: string;
}

/** Rarity info we cache per UTXO — derived from ord's /output + /sat endpoints. */
export interface UtxoSatInfo {
  /** First sat (offset 0) of this UTXO — the one ord would assign an inscription to. */
  firstSat: number;
  rarity: SatRarity;
  name: string;
  block: number;
}

// --- Bundle Types ---

export interface CommitBundle {
  version: 1;
  type: 'runes-etch-commit';
  createdAt: string;
  network: 'mainnet' | 'testnet' | 'signet';

  commitTxid: string;
  commitOutputIndex: number;
  commitOutputValue: number;

  runeName: string;
  targetUnlockHeight: number;

  tapscriptHex: string;
  controlBlockHex: string;
  internalPubkeyHex: string;

  inscriptionFile: {
    contentType: string;
    bodyBase64: string;
  } | null;

  delegateInscriptionId: string | null;
  parentInscriptionId: string | null;

  etching: {
    spacers: number;
    symbol: string;
    divisibility: number;
    premine: string;
    terms: {
      amount: string;
      cap: string;
      heightStart: number | null;
      heightEnd: number | null;
      offsetStart: number | null;
      offsetEnd: number | null;
    } | null;
    turbo: boolean;
  };
}

export interface BundleValidation {
  valid: boolean;
  commitUtxoExists: boolean;
  nameAvailable: boolean;
  nameUnlocked: boolean;
  currentHeight: number;
  blocksUntilUnlock: number;
  error: string | null;

  parentStatus: 'ready' | 'moved' | 'not-found' | 'none';
  parentCurrentAddress?: string;
}

/**
 * Shared commit/reveal vsize estimators for rune etch txs.
 *
 * Supports the address types this tool actually builds PSBTs for:
 *   - p2tr          (bc1p…)           taproot key-path / script-path
 *   - p2wpkh        (bc1q…)           native segwit
 *   - p2sh-p2wpkh   (3… / 2…)         nested segwit
 *
 * Ground truth from VLOVE mainnet (reveal weight 768 → 192 vB):
 * payment change is P2WPKH (31 vB), not P2TR (43 vB).
 */

export type ScriptType = 'p2tr' | 'p2wpkh' | 'p2sh-p2wpkh';
/** @deprecated Prefer ScriptType — kept as alias for call sites. */
export type ScriptOutType = ScriptType;

const TX_OVERHEAD_VB = 10.5;

// Input vbytes (BIP-141, typical signed sizes)
const P2TR_KEYPATH_IN_VB = 57.5;
const P2WPKH_IN_VB = 68;
const P2SH_P2WPKH_IN_VB = 91; // scriptSig redeem push + p2wpkh witness

// Output vbytes
const P2TR_OUT_VB = 43; // 8+1+34
const P2WPKH_OUT_VB = 31; // 8+1+22
const P2SH_OUT_VB = 32; // 8+1+23

export function isTaprootAddress(address: string): boolean {
  return (
    address.startsWith('bc1p') ||
    address.startsWith('tb1p') ||
    address.startsWith('bcrt1p')
  );
}

export function isNativeSegwitAddress(address: string): boolean {
  return (
    address.startsWith('bc1q') ||
    address.startsWith('tb1q') ||
    address.startsWith('bcrt1q')
  );
}

export function isNestedSegwitAddress(address: string): boolean {
  return address.startsWith('3') || address.startsWith('2');
}

/**
 * Classify a Bitcoin address for fee sizing.
 * Matches what `buildFundingPsbtInput` accepts (no legacy P2PKH).
 */
export function scriptTypeForAddress(address: string): ScriptType {
  if (isTaprootAddress(address)) return 'p2tr';
  if (isNativeSegwitAddress(address)) return 'p2wpkh';
  if (isNestedSegwitAddress(address)) return 'p2sh-p2wpkh';
  throw new Error(
    `Unsupported address type for fee sizing: ${address.slice(0, 12)}… ` +
      '(need bc1p taproot, bc1q native segwit, or 3…/2… nested segwit)',
  );
}

/** Alias used by commit/reveal builders. */
export function outputTypeForAddress(address: string): ScriptType {
  return scriptTypeForAddress(address);
}

export function inputVBytes(type: ScriptType): number {
  if (type === 'p2tr') return P2TR_KEYPATH_IN_VB;
  if (type === 'p2sh-p2wpkh') return P2SH_P2WPKH_IN_VB;
  return P2WPKH_IN_VB;
}

export function outputVBytes(type: ScriptType): number {
  if (type === 'p2tr') return P2TR_OUT_VB;
  if (type === 'p2sh-p2wpkh') return P2SH_OUT_VB;
  return P2WPKH_OUT_VB;
}

function compactSizeLen(n: number): number {
  if (n < 0xfd) return 1;
  if (n <= 0xffff) return 3;
  if (n <= 0xffffffff) return 5;
  return 9;
}

/** Non-witness input bytes (outpoint + scriptSig + sequence). */
function inputBaseBytes(type: ScriptType): number {
  if (type === 'p2sh-p2wpkh') {
    // 36 outpoint + 1 scriptSigLen + 23 redeem (OP_0 PUSH20 hash) + 4 sequence
    return 64;
  }
  // Native segwit / taproot: empty scriptSig
  return 41;
}

/** Witness weight units for one input (excluding shared marker/flag). */
function inputWitnessWeight(type: ScriptType): number {
  if (type === 'p2tr') {
    // stack count + len + 64-byte schnorr + sighash byte
    return 1 + 1 + 65;
  }
  // P2WPKH and P2SH-P2WPKH share the same witness: <sig> <pubkey>
  // ~1 + (1+72) + (1+33) ≈ 108
  return 1 + 1 + 72 + 1 + 33;
}

function outputBaseBytes(type: ScriptType): number {
  if (type === 'p2tr') return 8 + 1 + 34;
  if (type === 'p2sh-p2wpkh') return 8 + 1 + 23;
  return 8 + 1 + 22; // p2wpkh
}

/**
 * Commit tx (key-path / funding spends only). Change may be omitted (null).
 * Prefer `inputTypes` when known; count fields kept for UTXO preview callers.
 */
export function estimateCommitVBytes(params: {
  inputTypes?: ScriptType[];
  numTaprootInputs?: number;
  numSegwitInputs?: number;
  /** Nested P2SH-P2WPKH funding inputs (3…/2…). */
  numNestedSegwitInputs?: number;
  changeOutput: ScriptType | null;
}): number {
  let vb = TX_OVERHEAD_VB + P2TR_OUT_VB; // commit P2TR output always

  if (params.inputTypes && params.inputTypes.length > 0) {
    for (const t of params.inputTypes) vb += inputVBytes(t);
  } else {
    vb += (params.numTaprootInputs ?? 0) * P2TR_KEYPATH_IN_VB;
    vb += (params.numSegwitInputs ?? 0) * P2WPKH_IN_VB;
    vb += (params.numNestedSegwitInputs ?? 0) * P2SH_P2WPKH_IN_VB;
  }

  if (params.changeOutput) vb += outputVBytes(params.changeOutput);
  return Math.ceil(vb);
}

export interface EstimateRevealVBytesParams {
  tapscriptLen: number;
  hasParent: boolean;
  numFundingUtxos: number;
  /** Funding input types in order; defaults to p2tr key-path each. */
  fundingInputTypes?: ScriptType[];
  hasRuneOutput: boolean;
  changeOutput: ScriptType | null;
  opReturnScriptLen: number;
}

/**
 * Reveal tx weight model (BIP-141). Script-path commit input + optional
 * parent/funding inputs + typed outputs (native / nested / taproot).
 */
export function estimateRevealVBytes(params: EstimateRevealVBytesParams): number {
  const {
    tapscriptLen,
    hasParent,
    numFundingUtxos,
    hasRuneOutput,
    changeOutput,
    opReturnScriptLen,
  } = params;

  // Commit input is always P2TR script-path (empty scriptSig → 41 base bytes)
  let baseBytes =
    4 + // version
    1 + // input count
    41 + // commit script-path input
    1 + // output count
    4; // locktime

  if (hasParent) baseBytes += 41; // parent P2TR key-path

  const fundingTypes = params.fundingInputTypes;
  for (let i = 0; i < numFundingUtxos; i++) {
    const t = fundingTypes?.[i] ?? 'p2tr';
    baseBytes += inputBaseBytes(t);
  }

  if (hasRuneOutput) baseBytes += outputBaseBytes('p2tr');
  if (hasParent) baseBytes += outputBaseBytes('p2tr');
  baseBytes += 8 + 1 + opReturnScriptLen; // OP_RETURN
  if (changeOutput) baseBytes += outputBaseBytes(changeOutput);

  // Witness
  const witnessMarkerFlag = 2;
  const commitWitnessBytes =
    1 + // stack item count
    1 +
    64 + // length + schnorr sig (script path, no sighash byte)
    compactSizeLen(tapscriptLen) +
    tapscriptLen +
    1 +
    33; // control block (single leaf)

  const keyPathWitness = inputWitnessWeight('p2tr');
  let fundingWitness = 0;
  for (let i = 0; i < numFundingUtxos; i++) {
    const t = fundingTypes?.[i] ?? 'p2tr';
    fundingWitness += inputWitnessWeight(t);
  }

  const witnessBytes =
    witnessMarkerFlag +
    commitWitnessBytes +
    (hasParent ? keyPathWitness : 0) +
    fundingWitness;

  return Math.ceil((baseBytes * 4 + witnessBytes) / 4);
}

/**
 * Rough tapscript length when the real script is not built yet (UTXO preview).
 * Bare commitment ≈ 41 bytes; inscription adds envelope overhead + body pushes.
 */
export function estimateTapscriptLen(contentSize: number, hasInscription: boolean): number {
  const bare = 41;
  if (!hasInscription || contentSize <= 0) return bare;
  const chunks = Math.ceil(contentSize / 520);
  return bare + 40 + contentSize + chunks * 3;
}

/**
 * Typical OP_RETURN runestone script length for commit-time budgeting.
 * Reveal uses the real script length; this is a modest overestimate so the
 * commit lock is never short of fee budget for common etch terms.
 */
export const DEFAULT_RUNESTONE_SCRIPT_LEN = 40;

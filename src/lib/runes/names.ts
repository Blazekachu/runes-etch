/**
 * Rune name encoding/decoding and validation.
 * Reference: github.com/ordinals/ord — crates/ordinals/src/rune.rs
 *
 * Rune names use a modified bijective base-26 encoding:
 * A=0, B=1, ..., Z=25, AA=26, AB=27, ..., AZ=51, BA=52, ...
 *
 * Name availability uses interpolation between STEPS boundaries,
 * NOT a simple per-character-length threshold.
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const RUNES_ACTIVATION = 840000; // first_rune_height (mainnet, halving 4)
const SUBSIDY_HALVING_INTERVAL = 210000;
const UNLOCKED = 12; // number of unlock phases
const UNLOCK_INTERVAL = SUBSIDY_HALVING_INTERVAL / UNLOCKED; // 17500

/**
 * STEPS[i] = smallest rune numeric value with (i+1) characters.
 * From ord's Rune::STEPS constant. STEPS[0]=0 (A), STEPS[1]=26 (AA), etc.
 * These are the bijective base-26 boundaries.
 */
const STEPS: bigint[] = [
  0n,                          // 1-char:  A
  26n,                         // 2-char:  AA
  702n,                        // 3-char:  AAA
  18278n,                      // 4-char:  AAAA
  475254n,                     // 5-char:  AAAAA
  12356630n,                   // 6-char:  AAAAAA
  321272406n,                  // 7-char:  AAAAAAA
  8353082582n,                 // 8-char:  AAAAAAAA
  217180147158n,               // 9-char:  AAAAAAAAA
  5646683826134n,              // 10-char: AAAAAAAAAA
  146813779479510n,            // 11-char: AAAAAAAAAAA
  3817158266467286n,           // 12-char: AAAAAAAAAAAA
  99246114928149462n,          // 13-char: AAAAAAAAAAAAA
];

export function runeNameToU128(name: string): bigint {
  if (name.length === 0) throw new Error('Rune name cannot be empty');
  for (const ch of name) {
    if (ch < 'A' || ch > 'Z') throw new Error(`Invalid rune name character: '${ch}'. Only A-Z allowed.`);
  }
  let value = 0n;
  for (let i = 0; i < name.length; i++) {
    if (i > 0) { value += 1n; value *= 26n; }
    value += BigInt(name.charCodeAt(i) - 65);
  }
  return value;
}

export function u128ToRuneName(value: bigint): string {
  if (value < 0n) throw new Error('Value must be non-negative');
  let v = value;
  const chars: string[] = [];
  chars.push(ALPHABET[Number(v % 26n)]);
  v = v / 26n;
  while (v > 0n) {
    v -= 1n;
    chars.push(ALPHABET[Number(v % 26n)]);
    v = v / 26n;
  }
  return chars.reverse().join('');
}

export function runeNameToCommitmentBytes(name: string): Uint8Array {
  const value = runeNameToU128(name);
  const bytes: number[] = [];
  let v = value;
  do {
    bytes.push(Number(v & 0xffn));
    v >>= 8n;
  } while (v > 0n);
  return new Uint8Array(bytes);
}

export function spacerBitmask(name: string, positions: number[]): number {
  let mask = 0;
  for (const pos of positions) {
    if (pos < 0 || pos >= name.length - 1) {
      throw new Error(`Spacer position ${pos} out of range for name "${name}" (max: ${name.length - 2})`);
    }
    if (pos > 30) {
      throw new Error(`Spacer position ${pos} exceeds 32-bit bitmask limit`);
    }
    mask |= 1 << pos;
  }
  return mask;
}

/**
 * Compute the minimum rune numeric value at a given block height.
 * Matches ord's `Rune::minimum_at_height` exactly.
 *
 * Within each 17,500-block window, the minimum interpolates linearly
 * between two STEPS boundaries. This means some short names unlock
 * earlier than others (alphabetically later names first).
 */
export function minimumAtHeight(blockHeight: number): bigint {
  // M8: +1 because the TX will be mined in the NEXT block (height+1), not the current tip
  const offset = blockHeight + 1;
  const start = RUNES_ACTIVATION;
  const end = start + SUBSIDY_HALVING_INTERVAL;

  if (offset < start) return STEPS[UNLOCKED];
  if (offset >= end) return 0n;

  const progress = offset - start;
  const length = UNLOCKED - Math.floor(progress / UNLOCK_INTERVAL);

  const stepEnd = STEPS[length - 1];
  const stepStart = STEPS[length];
  const remainder = BigInt(progress % UNLOCK_INTERVAL);

  return stepStart - ((stepStart - stepEnd) * remainder / BigInt(UNLOCK_INTERVAL));
}

/**
 * Get the minimum name character length available at a height.
 * This is an approximation — within a window, some names of this length
 * are available and some aren't. Use minimumAtHeight() for exact checks.
 */
export function minNameLengthAtHeight(blockHeight: number): number {
  const minValue = minimumAtHeight(blockHeight);
  // Find which character length this value falls in
  for (let i = STEPS.length - 1; i >= 0; i--) {
    if (minValue >= STEPS[i]) return i + 1;
  }
  return 1;
}

/**
 * Compute the rune-name minimum at a given block height for an arbitrary
 * chain activation. Mirrors `minimumAtHeight` exactly but takes the activation
 * height as a parameter so it can be used for non-mainnet chains.
 *
 * For mainnet, callers should pass `RUNES_ACTIVATION` (840,000). For testnet4
 * or any other chain, callers need the chain-specific `first_rune_height`.
 *
 * Exposed for `blocksUntilNameUnlocks` to do exact binary search; the existing
 * `minimumAtHeight` wraps this with the mainnet default.
 */
function minimumAtHeightWithActivation(
  blockHeight: number,
  activationHeight: number,
): bigint {
  const offset = blockHeight + 1;
  const start = activationHeight;
  const end = start + SUBSIDY_HALVING_INTERVAL;

  if (offset < start) return STEPS[UNLOCKED];
  if (offset >= end) return 0n;

  const progress = offset - start;
  const length = UNLOCKED - Math.floor(progress / UNLOCK_INTERVAL);
  const stepEnd = STEPS[length - 1];
  const stepStart = STEPS[length];
  const remainder = BigInt(progress % UNLOCK_INTERVAL);

  return stepStart - ((stepStart - stepEnd) * remainder / BigInt(UNLOCK_INTERVAL));
}

/**
 * Exact: how many more blocks must elapse before a name with `targetValue`
 * becomes etchable without commit-reveal at the given chain. The returned
 * value `k` is the smallest integer such that
 * `minimumAtHeightWithActivation(currentBlockHeight + k - 1, activationHeight) <= targetValue`.
 *
 * Algorithm: binary search over `minimumAtHeightWithActivation`. This is the
 * same primitive ord uses to gate etching, so the result is bit-exact against
 * the protocol's actual rule. Search bound is `SUBSIDY_HALVING_INTERVAL`
 * (210,000 blocks); any name unlocks within one halving of activation.
 *
 * Defaults to mainnet activation. For testnet4 or other chains, pass the
 * appropriate `activationHeight` — without it the answer is mainnet-only.
 *
 * Returns 0 if the name is already etchable at `currentBlockHeight`.
 * Returns -1 if the search exhausts (shouldn't happen for valid inputs).
 *
 * Verified bit-exact against `minimumAtHeight` brute force across 50 randomized
 * (name, anchor) pairs plus targeted same-phase and cross-phase scenarios —
 * see `blocksUntilNameUnlocks — exact-match verification` in names.test.ts.
 */
export function blocksUntilNameUnlocks(
  targetValue: bigint,
  currentBlockHeight: number,
  activationHeight: number = RUNES_ACTIVATION,
): number {
  // Already etchable now? minimumAtHeight(currentBlockHeight - 1) is the
  // minimum that applies to TXs mined at `currentBlockHeight` — i.e. "if I
  // broadcast now and get into the next block."
  if (minimumAtHeightWithActivation(currentBlockHeight - 1, activationHeight) <= targetValue) {
    return 0;
  }

  // Binary search: find smallest k in [1, SUBSIDY_HALVING_INTERVAL+1] such
  // that the name is etchable at block (currentBlockHeight + k).
  // minimumAtHeightWithActivation is monotonically non-increasing in offset,
  // so binary search is valid.
  let lo = 1;
  let hi = SUBSIDY_HALVING_INTERVAL + 1;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (minimumAtHeightWithActivation(currentBlockHeight + mid - 1, activationHeight) <= targetValue) {
      hi = mid;
    } else {
      lo = mid + 1;
    }
  }
  return lo <= SUBSIDY_HALVING_INTERVAL ? lo : -1;
}

/**
 * Compute the block height at which a specific name becomes available.
 * This accounts for the interpolation — shorter alphabetical names
 * within a length class unlock later than longer ones.
 */
export function computeUnlockHeight(name: string): number {
  const value = runeNameToU128(name);
  const charLen = name.length;

  if (charLen > 12) {
    // 13+ char names available from activation
    return RUNES_ACTIVATION;
  }
  if (charLen < 1) return RUNES_ACTIVATION + SUBSIDY_HALVING_INTERVAL;

  // Which STEPS interval does this name fall in?
  // STEPS[charLen] = start of this char-length range
  // STEPS[charLen - 1] = end (start of shorter range)
  const stepStart = STEPS[charLen];
  const stepEnd = STEPS[charLen - 1];

  // The window index for this character length: UNLOCKED - charLen
  const windowIndex = UNLOCKED - charLen;
  const windowStart = RUNES_ACTIVATION + windowIndex * UNLOCK_INTERVAL;

  if (stepStart === stepEnd) return windowStart;

  // Interpolation: value = stepStart - (stepStart - stepEnd) * remainder / UNLOCK_INTERVAL
  // Solve for remainder: remainder = (stepStart - value) * UNLOCK_INTERVAL / (stepStart - stepEnd)
  const numerator = (stepStart - value) * BigInt(UNLOCK_INTERVAL);
  const denominator = stepStart - stepEnd;
  const remainder = Number(numerator / denominator);

  return windowStart + Math.min(remainder, UNLOCK_INTERVAL - 1);
}

/**
 * Validate whether a specific rune name can be etched at the given block height.
 *
 * Three precedence levels for the minimum:
 *  1. `runeMinimum` (authoritative — typically from ord `/status.minimum_rune_for_next_block`).
 *     Chain-agnostic. Use this for testnet4 where the local computation is wrong.
 *  2. Mainnet local computation via `minimumAtHeight(currentBlockHeight)` — only
 *     correct for mainnet (`RUNES_ACTIVATION = 840000` is hard-coded).
 *  3. Permissive testnet fallback — when caller has no authoritative minimum
 *     AND can't trust the mainnet computation, accept the name. Caller is on
 *     the hook for the catastrophe (Finding #11: BUDDY-style silent cenotaphs).
 */
export function validateRuneName(
  name: string,
  currentBlockHeight: number,
  /** Permissive fallback when `runeMinimum` is not supplied (legacy behavior). */
  isTestnet = false,
  /** Authoritative chain rune-name minimum (e.g. from ord). Trumps local computation. */
  runeMinimum: bigint | null = null,
): { valid: true } | { valid: false; error: string; unlockHeight?: number } {
  if (!/^[A-Z]+$/.test(name)) return { valid: false, error: 'Rune name must contain only letters A-Z' };
  if (name.length > 28) return { valid: false, error: 'Rune name cannot exceed 28 characters' };

  // Authoritative path — use the supplied minimum regardless of chain. Fixes
  // Finding #11 on testnet4 where mainnet `minimumAtHeight()` is wrong.
  if (runeMinimum !== null) {
    const nameValue = runeNameToU128(name);
    if (nameValue < runeMinimum) {
      const minName = u128ToRuneName(runeMinimum);
      // Finding #15: project when the name will unlock so the user knows
      // which block to time the reveal for. EXACT only on mainnet — testnet4
      // has a different `first_rune_height` we don't know reliably, so we
      // skip the projection there (the warning still tells the user to use
      // commit-reveal mode).
      let unlockHeight: number | undefined;
      if (!isTestnet && currentBlockHeight > 0) {
        const blocksToUnlock = blocksUntilNameUnlocks(nameValue, currentBlockHeight);
        if (blocksToUnlock > 0) {
          unlockHeight = currentBlockHeight + blocksToUnlock;
        }
      }
      return {
        valid: false,
        error: `"${name}" is below the chain's current rune-name minimum "${minName}" (${minName.length} letters). Pick a name whose value is ≥ "${minName}", or use a commit-reveal mode that supplies a commitment.`,
        unlockHeight,
      };
    }
    return { valid: true };
  }

  // Permissive fallback — testnet without an authoritative minimum. Caller is
  // expected to pass `runeMinimum` on testnet4; this branch is for testnet3 /
  // regtest where runes are inactive.
  if (isTestnet) return { valid: true };

  // Mainnet local computation. Pre-#11 behavior, unchanged.
  // Without a real chain tip we can't decide what's etchable — `minimumAtHeight(0)`
  // would return the pre-activation minimum ("AAAAAAAAAAAAA") and produce a
  // misleading "must be 13 letters" message. Tell the caller to wait/retry.
  if (!currentBlockHeight || currentBlockHeight < 840000) {
    return { valid: false, error: 'Loading current block height — try again in a moment.' };
  }

  const nameValue = runeNameToU128(name);
  const minValue = minimumAtHeight(currentBlockHeight);

  if (nameValue < minValue) {
    const unlockHeight = computeUnlockHeight(name);
    const minName = u128ToRuneName(minValue);
    // Use minName.length (the current minimum's actual length), not name.length —
    // the protocol gates on the rune's u128 value, and shorter names unlock as the
    // minimum value drops. Reporting "5-letter name is RBRWYI" was wrong when
    // RBRWYI is 6 letters and 5-letter names aren't unlocked yet.
    return {
      valid: false,
      error: `"${name}" unlocks at block ${unlockHeight.toLocaleString()}. ` +
        `Currently the minimum etchable name is "${minName}" (${minName.length} letters).`,
      unlockHeight,
    };
  }
  return { valid: true };
}

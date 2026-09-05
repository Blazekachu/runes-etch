# Finding: Commit feerate mismatch (target 0.88 → on-chain ~1.21)

**Status:** Record only — do **not** implement until reveal for this etch is done.  
**Date:** 2026-09-05  
**Mainnet commit txid:** `420258fca049e6c6cadc169dce62238aa5f66aebd281f3d46becab08276db669`

## Symptom

- UI / user selected **commit fee rate = 0.88 sat/vB**
- Explorers report **~1.21 sat/vB**

## On-chain facts (mempool.emzy.de)

| Field | Value |
|-------|------:|
| weight | 485 |
| size | 203 |
| fee (sats) | 147 |
| vsize (`ceil(weight/4)`) | 122 |
| effective rate (`fee / vsize`) | **1.2049 ≈ 1.21** |
| exact rate (`fee / (weight/4)`) | 1.2124 |
| vin | 1× native **P2WPKH** (`bc1qe9qa0…`) value **1671** |
| vout | 1× **P2TR** commit output value **1524** (no change output) |

`fee = 1671 − 1524 = 147`.

## Root cause (not a 0.88 parse bug)

Target fee for the **actual** 1-in / 1-out shape is correct in isolation:

```
estimateCommitVBytes(0 taproot, 1 segwit, 1 out)
  = ceil(10.5 + 68 + 43) = 122 vB
feeFromVSize(122, 0.88) = round(107.36) = 107 sats
→ ~0.88 sat/vB
```

What happened instead:

1. Builder sizes fee assuming a change output may exist, then drops change when `change < DUST_LIMIT` (546).
2. After dropping change, leftover sats that are still below dust are **not returned** and are **not folded into an explicit fee target**.
3. PSBT has only `commit.vout[0]` → miners receive **all** leftover:

```
intended fee (0.88 × 122) ≈ 107
dust leftover                = 1671 − 1524 − 107 = 40
actual fee                   = 107 + 40 = 147
effective rate               = 147 / 122 ≈ 1.21 sat/vB
```

So the mismatch is **dust absorption into the miner fee**, which inflates the **effective** sat/vB above the selected rate. Fractional-rate support did not cause this; the same class of bug exists for integer rates whenever change is dust.

Relevant code: `src/lib/runes/commit.ts` — after re-estimating with `numOutputs = 1`, if `changeValue` remains `< DUST_LIMIT`, no change output is added and the extra sats silently raise the feerate.

## Why explorers show “1.21”

They display `fee / vsize` with `vsize = ceil(weight/4)` (or similar).  
147 / 122 ≈ **1.20–1.21**, not 0.88.

## Proposed fix (implement later — after this reveal)

When change would be dust on the final 1-output layout, either:

1. **Absorb dust into fee explicitly** and surface effective rate in UI (`actualFee / actualVsize`), or  
2. **Add change anyway** only if economical (usually not under dust), or  
3. **Select a larger funding UTXO / add another input** so change ≥ 546 and the target rate is preserved, or  
4. **Bump commit output** by the dust leftover (usually wrong for reveal budgeting) — generally avoid.

Prefer (1) + UI honesty: show both **target rate** and **effective rate** when they diverge by dust absorption. Optionally warn before broadcast: “Change is dust; effective feerate will be X.XX not Y.YY.”

Same review needed for **reveal** (`src/lib/runes/reveal.ts`) when reveal change is dust.

## Non-goals for this note

- Do not change fee code until the pending reveal for this commit is broadcast (user: next ~7–8 blocks).
- Unlock-height / ordinals.com off-by-one is unrelated.

## Quick checklist when implementing

- [ ] Reproduce with 1× P2WPKH in, 1× P2TR out, input value such that `input − commitOut − feeTarget < 546`
- [ ] Assert broadcast feerate ≈ target unless UI warned about dust absorption
- [ ] Show effective feerate in TxPreview / BuildButton confirm
- [ ] Mirror fix + warn path on reveal builder

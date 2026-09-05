# Comprehensive post-mortem: VLOVE mainnet etch

**Date:** 2026-09-05  
**Rune:** `VLOVE` (etched successfully)  
**Verdict (unlock):** ordinals.com unlock height was **correct**; our tool showed **1 block late**.  
**Status:** Analysis / findings only — implement fixes in a follow-up.

---

## Transactions (ground truth)

| | Txid | Block | Fee | Notes |
|--|------|------:|----:|-------|
| **Commit** | `420258fca049e6c6cadc169dce62238aa5f66aebd281f3d46becab08276db669` | **965558** | 147 sats | 1× P2WPKH in (1671) → 1× P2TR commit out (**1524**), **no change** |
| **Reveal** | `4204866e07ba0dd5d77d950197914fdafce11506fc810b73cb88f7804c3e6d69` | **965565** | 359 sats | → 546 P2TR (rune) + OP_RETURN + **619 P2WPKH change** to payment |

**Etch result (ordinals.com):**

- Rune **VLOVE** exists (HTTP 200)
- Etching block **965565**, id **965565:1161**
- Etching tx = reveal above

---

## 1. Unlock height — we were 1 block late

| Source | Unlock height | What happened |
|--------|--------------:|---------------|
| ordinals.com | **965565** | Reveal confirmed here; rune valid |
| our tool (`computeUnlockHeight`) | **965566** | Would have told user to wait one more block |

**Conclusion:** For this live mainnet etch, **ordinals.com’s unlock height matched reality**. Our UI/protocol projection was **one block late**, not early.

Earlier lab note (`unlockHeight100` / Finding #15) argued the opposite (ord.com 1 early / cenotaph risk). This etch **falsifies that for unlock display**: etching in **965565** produced a real rune, not a cenotaph.

### Why our math disagreed

We defined:

```text
etchable in block X  ⟺  minimumAtHeight(X - 1) ≤ name
```

Under that rule, `minimumAtHeight(965564)` still had VLOVE locked, so we reported unlock **965566**.  
Chain reality: valid etch in **965565**.

Related tip quirk (same off-by-one family): at a given tip `H`, ord’s `minimum_rune_for_next_block` lined up with our `minimumAtHeight(H+1)`, not `minimumAtHeight(H)`.

### Fix direction (later)

- Reconcile `minimumAtHeight` / `blocksUntilNameUnlocks` / `computeUnlockHeight` with ord’s `Rune::minimum_at_height` **as applied to the block containing the etch**.
- Align unlock UI with the height that just worked: **ord.com’s number for VLOVE (965565)**.
- Update Finding #15 tests that encoded “ours = ord + 1” as gospel.
- Keep safety: until math is bit-exact, prefer matching public ord unlock (or show both).

---

## 2. Commit fee 0.88 → ~1.21 (dust to miners)

**Target:** 0.88 sat/vB  
**On-chain:** 147 sats / 122 vB ≈ **1.21 sat/vB**

### Intended vs actual

| | Sats |
|--|-----:|
| Input | 1671 |
| Commit output (reveal budget lock) | 1524 |
| Fee if exactly 0.88 × 122 vB | ~107 |
| **Actual fee** | **147** |
| Extra to miners | **~40** |

### Why

1. Builder computes change = `input − commitOut − targetFee`.
2. That change was **&lt; 546 dust** → **no change output**.
3. Leftover sats are implicitly mined (absorbed into fee) → **effective feerate rises**.

This is **not** caused by decimal fee parsing. Same class of bug for integer rates whenever leftover &lt; dust.

**Finding file:** `docs/findings/commit-feerate-dust-absorption.md`

---

## 3. “Why lock only recommended sats in commit, but UTXO was overloaded?”

Two different pots of money:

### A. Commit output (1524) — intentional reveal budget

```text
commit.vout[0] = revealFeeBudget + runeDust(546) + revealChangeReserve(546)
```

For this etch (bare rune, reveal budget **1.75**):

- Commit used the **crude** `estimateRevealVBytes` in `commit.ts` → **~247 vB**
- `revealFeeBudget = round(247 × 1.75) = 432`
- `commitOut = 432 + 546 + 546 = 1524` ← matches chain

So the UI “lock in commit” amount is **pre-funding the reveal**, not the commit miner fee.

### B. Funding UTXO (1671) — whole coin selected to pay commit

Smart-select / user picks a **payment UTXO ≥ commitOut + commitFee**.

```text
need ≈ 1524 + ~107 = 1631
selected UTXO = 1671
```

Leftover after paying commitOut + target commit fee ≈ **40 sats** → below dust → **cannot return to payment on the commit tx** → miners.

### C. Reveal change (619) — returning to payment (by design + overestimate)

Reveal spent the 1524 commit output:

| Output | Sats | Meaning |
|--------|-----:|---------|
| Rune receiver (P2TR) | 546 | protocol dust |
| OP_RETURN runestone | 0 | |
| **Change (P2WPKH payment)** | **619** | back to `bc1qe9qa0…` |
| Miner fee | 359 | |

```text
619 = (432 − 359) spare reveal-fee budget + 546 revealChangeReserve
    = 73 + 546
```

So:

- **546** of the 619 is the **explicit change reserve** baked into commit on purpose (“unused reveal budget returns to payment”).
- **73** is extra because commit oversized the reveal fee budget (crude estimator) vs what reveal actually charged (still wrong, but lower).

**Answer to “why recommended locking only X but overloaded?”**  
The tool recommends locking **1524 in the commit output** for reveal. It does **not** split your 1671 UTXO into “exact commitOut + exact fee + change” when change would be dust—it spends the whole UTXO and burns the dust remainder to fees. That feels like “overload,” but it’s **dust policy + whole-UTXO funding**, not an accidental second lock.

---

## 4. Reveal fee 1.75 → ~1.87 (vsize overestimate)

**Target:** 1.75 sat/vB  
**On-chain:** 359 / 192 ≈ **1.87 sat/vB**

Reveal builder estimated **205 vB** → `round(205 × 1.75) = 359` (exact fee paid).  
Actual weight **768** → **192 vB**.

### Estimator bugs (`reveal.ts` `estimateRevealVBytes`)

1. **Dominant:** change output costed as **P2TR 43 vB**; real change was **P2WPKH 31 vB** (+12 base bytes).
2. Minor: 65-byte sig placeholder vs 64-byte witness; tapscript length varint padding.

### Second structural issue: **two different reveal size estimators**

| Stage | Function | Est. vB @ this etch | Fee @ 1.75 |
|-------|----------|--------------------:|-----------:|
| Commit funding | `commit.ts` crude `estimateRevealVBytes` | **247** | **432** budget |
| Reveal build | `reveal.ts` detailed `estimateRevealVBytes` | **205** | **359** paid |
| Reality | bitcoin weight/4 | **192** | would be **336** at 1.75 |

Commit over-funds; reveal still over-pays vs true size; user sees 1.87 not 1.75; leftover budget returns as part of the **619** payment change.

**Finding file:** `docs/findings/vlove-reveal-unlock-and-feerate.md`

---

## 5. Money-flow summary (end-to-end)

```text
Payment UTXO 1671
    │
    ├─ Commit @ 965558
    │     ├─ commit.vout[0]  1524  (reveal budget lock)
    │     └─ miner fee        147  (target ~107 @ 0.88 + ~40 dust absorption)
    │     └─ change to payment: NONE (dust)
    │
    └─ Reveal @ 965565 (spends 1524)
          ├─ rune output      546
          ├─ miner fee        359  (target ~336 @ 1.75 on real vsize; paid via 205 vB estimate)
          └─ change payment   619  ← user-visible return to payment address
```

Net from the 1671 coin:

- 546 remains on rune/taproot receiver  
- 619 back to payment  
- 147 + 359 = **506** to miners  
- (plus whatever economic “cost” of holding 1524 until reveal)

---

## 6. What went wrong — checklist

| # | Issue | Impact | Root cause |
|---|--------|--------|------------|
| 1 | Unlock height | UI said **965566**; etch OK at **965565** | Off-by-one vs ord / wrong `minimumAtHeight` indexing for unlock |
| 2 | Commit feerate 0.88→1.21 | Overpaid commit fee | Dust change absorbed into miner fee |
| 3 | Whole UTXO / “overload” feel | ~40 sats couldn’t return on commit | Funding UTXO leftover &lt; dust; no commit change output |
| 4 | Dual reveal estimators | Commit locked **432** fee budget; reveal spent **359** | `commit.ts` vs `reveal.ts` different `estimateRevealVBytes` |
| 5 | Reveal feerate 1.75→1.87 | Overpaid reveal fee | Reveal vsize overestimate (P2WPKH change as P2TR, etc.) |
| 6 | 619 change | Correct that it returns to payment | By design (546 reserve) + spare overestimate (73) |

---

## 7. Implementation status (2026-09-05)

1. **Unlock:** Done — etchable at `X` iff `minimumAtHeight(X) ≤ name` (ord `unlock_height`); VLOVE = **965565**.
2. **Single reveal vsize model:** Done — shared `src/lib/runes/etchTxSize.ts` used by commit funding + reveal build.
3. **Output typing:** Done — P2WPKH vs P2TR in estimators.
4. **Dust policy (commit):** Done — sub-dust leftover folded into `commit.vout[0]` (returns on reveal). Remaining: UI target-vs-effective sat/vB warning.
5. **UI copy:** Still open — clarify commit lock = reveal budget (fee + rune dust + change reserve).

---

## 8. Prior notes to supersede

- `docs/findings/commit-feerate-dust-absorption.md` — fee mechanism still valid; unlock “ord early” narrative **superseded** by this etch.
- `docs/findings/vlove-reveal-unlock-and-feerate.md` — fee section stands; unlock section updated by this document’s verdict.

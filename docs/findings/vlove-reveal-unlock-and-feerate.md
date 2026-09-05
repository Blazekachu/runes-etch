# Finding: VLOVE reveal — unlock-height A/B test + reveal feerate 1.75→1.87

**Status:** Fee root cause recorded. Unlock verdict: **ordinals.com correct; our tool 1 block late** (etch at 965565 succeeded). See full write-up: `vlove-mainnet-postmortem.md`.  
**Date:** 2026-09-05  
**Do not implement fee fixes until user says etch flow is done** (same hold as commit dust finding).

## Transactions

| Role | Txid |
|------|------|
| Commit | `420258fca049e6c6cadc169dce62238aa5f66aebd281f3d46becab08276db669` |
| Reveal | `4204866e07ba0dd5d77d950197914fdafce11506fc810b73cb88f7804c3e6d69` |

## Unlock-height experiment (VLOVE)

| Source | Unlock height | Etchable in that block? |
|--------|--------------:|:------------------------|
| ordinals.com | **965565** | **No** (protocol: `minimumAtHeight(965564) > VLOVE`) |
| our tool | **965566** | **Yes** |

**How to score the test (after reveal confirms):**

- Reveal mined in **965565** and rune **VLOVE exists / valid etch** → ordinals.com height wins (unexpected vs our math).
- Reveal mined in **965565** and result is **cenotaph / no rune** → **our tool is correct**.
- Reveal mined in **≥965566** and valid etch → consistent with **our tool** (does not prove ord.com wrong if it never landed on 965565).

As of recording: tip was **965564**, reveal **unconfirmed** in mempool. ordinals.com still 404 with unlock height 965565.

## Reveal fee mismatch (1.75 → ~1.87)

### On-chain

| Field | Value |
|-------|------:|
| weight | 768 |
| vsize | 192 |
| fee | 359 sats |
| effective rate | **359 / 192 ≈ 1.87 sat/vB** |
| vin | 1× commit P2TR (1524 sats) |
| vouts | 546 P2TR (rune) + 0 OP_RETURN + **619 P2WPKH change** |

Target **1.75** on **actual** 192 vB → `round(192 × 1.75) = 336` sats (~1.75).  
Paid **359** sats instead.

### Root cause: reveal **vsize overestimate** (not dust this time)

Builder used `estimateRevealVBytes` → **205 vB**:

`round(205 × 1.75) = 359` ← matches on-chain fee exactly.

Actual weight/vsize = **768 / 192**.

Reproduced estimator vs actual:

| | Estimator | Actual / corrected |
|--|----------:|-------------------:|
| base bytes | 168 | 156 |
| witness bytes | 147 | 144 |
| weight | 819 | 768 |
| vbytes | **205** | **192** |

Main estimator bugs in `src/lib/runes/reveal.ts` `estimateRevealVBytes`:

1. **Change output sized as P2TR (43 vB)** but payment change is **P2WPKH (31 vB)** → **+12 base bytes** (dominant).
2. Minor: assumes **65-byte** script-path sig placeholder; tx used **64-byte** witness item; tapscript length varint over-allocated (`3 + len` vs `1 + len` for short scripts).

Unlike the commit 0.88→1.21 case (dust absorption with **no** change output), this reveal **did** create change (619). The fee was set from an **inflated vbyte estimate**, so effective feerate rose: `359/192 ≈ 1.87`.

## Relation to prior finding

| Tx | Target | Observed | Mechanism |
|----|-------:|---------:|-----------|
| Commit | 0.88 | ~1.21 | Dust change absorbed into miner fee |
| Reveal | 1.75 | ~1.87 | Vsize overestimate (P2WPKH change counted as P2TR) |

See also: `docs/findings/commit-feerate-dust-absorption.md`

## Proposed fix (later)

1. Size change output as **P2WPKH (31)** when `changeAddress` is payment/segwit (or pass output types into estimator).
2. Tighten script-path witness estimate (64-byte sig, compact-size script length).
3. Optionally recompute fee from **serialized PSBT weight** before finalize (ground truth).
4. UI: show **target vs effective** sat/vB when they diverge.

## Checklist when implementing

- [ ] Wait for reveal confirm height; append unlock verdict below
- [ ] Unit test: bare reveal, 1 commit in, P2TR rune + OP_RETURN + P2WPKH change → estimate within ~1–2 vB of bitcoinjs weight
- [ ] Same for commit dust path (prior finding)

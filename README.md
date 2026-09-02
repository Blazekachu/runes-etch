# Runes Etch

**Self-custodial Bitcoin Runes etching tool.** Web-based, client-side only, no backend. Etch new runes on Bitcoin **mainnet** or **signet** — with an optional inscription, optional parent linkage, vanity TXID grinding, and full bundle recovery — without ever handing over your keys.

> Status: v2 three-mode commit-reveal flow · 177 automated tests passing · signet replaces testnet4 as the dev chain (Aug 2026)

---

## What this tool does

Runes Etch builds and broadcasts the **commit + reveal** transactions that etch a new rune, entirely in your browser. Your wallet signs every PSBT; private keys never reach the page. There is **no "quick" single-transaction mode** — etching a *named* rune requires a name commitment in an aged input, so every etch here is commit-reveal by protocol necessity.

### Three etching modes

You pick the mode up front; the builder shows only the sections that mode needs and clears any state that doesn't belong to it.

| Mode | What it produces | Front-run / integrity protection |
|---|---|---|
| **Parent Child** | A rune **+ a new child inscription** linked to a **parent inscription you own**. Child content can be a file, inline text, or a delegate. | Name commitment + child inscription + parent lineage |
| **Rune With Inscription** | A rune **+ a new inscription** (file, text, or delegate), with no parent lineage. | Name commitment + inscription |
| **Rune** | Just the rune — name, supply, mint terms, symbol, turbo. No inscription, no parent. | Name commitment |

### Cenotaph & name-safety guards

A rune that's etched with a bad name is silently destroyed (a *cenotaph*) — the transaction confirms but no rune is created, and the fees are gone. Runes Etch actively prevents this:

- **Name availability is re-checked before the commit *and* again immediately before the reveal**, against a live indexer.
- The reveal is **blocked** if the name is already etched, or if the indexer can't currently be trusted (lagging or wedged on a reorg) — with a distinct, actionable message for each case.
- The reveal is **blocked** if the name is still below the chain's current rune-name minimum, with the **exact unlock block** shown (mainnet computed from activation; signet inferred from your ord's reported minimum). An explicit advanced override is required to proceed anyway.
- The reveal only unlocks at **5 commit confirmations**, so it lands at the protocol-required 6th confirmation.

### Correct ordinal routing (no lost inscriptions)

Outputs are placed deterministically so nothing valuable ever drifts into the fee:

- **Rune + new inscription** → your **taproot (ordinals)** address.
- **Parent inscription (Parent Child mode)** → spent as the **first input** and returned as the **first output** to your **taproot** address, so the parent sat can never fall into the fee tail.
- **Change** → your **payment (segwit)** address.

### Separate commit / reveal fee rates

The commit output **pre-funds** the reveal at a chosen reveal-fee budget. At reveal time you can pay any rate up to that budget; any unused budget returns to your payment address as change. The cost preview itemizes commit fee, reveal-fee budget, dust reserves, and the locked commit output.

### Vanity TXID grinding (commit and reveal)

Grind the **commit** TXID and/or the **reveal** TXID to start or end with chosen hex characters.

- Up to 6 hex characters; runs in a Web Worker so the UI stays responsive.
- Grinds by varying `nLockTime` while all input sequences stay final — consensus-safe, semantics unchanged.
- Cached tapscript / control block / internal pubkey guarantee the grinded TXID matches the actual signed TX.
- After signing, the final TXID is re-checked against your target and **broadcast is refused on any mismatch**.
- The fee rate locks once a vanity nonce is found (changing it would invalidate the grind).

### Targeting a specific sat or inscription (reinscription)

In the inscription modes you can paste a **sat number or inscription ID** as the carrier. The tool resolves it via ord, verifies you own it and that it sits at the expected offset, and uses it as the first input — no slow taproot enumeration. Reinscription onto an existing inscribed sat is supported this way.

### Smart UTXO selection & funding

- Itemized cost estimate (commit fee + reveal budget + dust) before you choose.
- Payment UTXOs load and render first; the slower taproot/ord-label pass streams in after, so you can start picking fee UTXOs immediately. Partial failures are isolated.
- Auto-selects the minimum set (largest-first, payment preferred); live funding bar (green when funded, orange with the deficit shown).
- **Rare-sat awareness** (mainnet, via ord): per-UTXO rarity badges and a "primary" UTXO picker that controls which sat carries the inscription.
- Hoarder-friendly: when an address has too many UTXOs for the `/utxo` endpoint (HTTP 400), it falls back to deriving UTXOs from the address tx history.

### Resilient data providers

- **mempool.space** is primary; **mempool.emzy.de** is an automatic fallback for UTXOs, fees, tip height, and **broadcast** — on both mainnet and signet.
- Network is detected from your **wallet** (sats-connect reports Signet/Mainnet); signet and legacy testnet4 share `tb1` addresses so prefix alone is not used.
- An **ord-health banner** warns when your indexer is lagging or wedged on a reorg, with network-aware recovery advice.

### Bundle recovery

- A recovery **bundle is downloaded automatically the moment your commit broadcasts**, and you can export one manually at any time.
- It carries the tapscript, control block, internal pubkey, etching details, and reveal-fee budget — so you can **resume on another device or after clearing storage** without losing vanity work.
- "Start Over" warns loudly if you have an unfinished commit and no saved bundle.

### Wallets

- **Xverse** — via `sats-connect` `wallet_connect` (provides both the Ordinals/taproot and Payment addresses, plus network). Recommended, and required for signet inscription/parent flows.
- **Leather** — direct `window.LeatherProvider`. Note: on non-mainnet Leather may return a **segwit address only (no taproot)**, so use Xverse for signet etches that need a taproot.
- Provider choice persists; wallet identity is dropped after 7 days; reconnect prompt appears after a refresh.

---

## Requirements (for the tool to work well)

**A compatible wallet exposing two addresses:**
- A **taproot (ordinals)** address — every rune and inscription lands here. *(Xverse provides this on both networks; Leather does **not** provide one on testnet.)*
- A spendable **payment (segwit)** address to fund the etch.
- → **Use Xverse** for the full feature set, especially on signet.

**Funds.** Enough spendable BTC in the payment address to cover, in one etch: the **commit output** (which pre-funds the reveal) + the **commit fee** + the **reveal fee** + **dust** outputs. The UI shows the exact estimate — keep a little headroom.

**A valid rune name.** At or above the chain's current minimum. The tool displays the current minimum and, if your name is still locked, the exact block it unlocks at.

**For Parent Child mode.** You must already **own the parent inscription** in the connected taproot wallet — the tool spends it and returns it to you.

**Patience + your bundle.** The reveal can't broadcast until the commit has 5 confirmations. Keep the tab open, and keep the auto-downloaded bundle so you can resume later or on another machine.

**Network setup:**
- **Mainnet** — nothing extra. Uses public `ordinals.com` + `mempool.space` (with the emzy fallback) out of the box.
- **Signet (for full functionality)** — run your **own ord** with all index flags (`--index-runes --index-sats --index-addresses` plus inscription/transaction indexes) and point the app at it with `NEXT_PUBLIC_ORD_BASE_SIGNET` (e.g. `http://127.0.0.1:8080`). Without a local signet ord, **name-availability checks, rare-sat badges, and parent current-location resolution degrade or are skipped** (you lose those safety nets, though the etch can still proceed). Fund via [signetfaucet.com](https://signetfaucet.com) (Xverse → Signet network).

**Browser.** A current desktop browser with the wallet extension installed.

**Don't change the reveal fee after grinding a vanity TXID** — it invalidates the grind. The UI locks it for you.

---

## Quick Start

```bash
npm install
npm run dev
```

Open <http://localhost:3000>.

For dev mode, create `.env.local` (the CSP override is needed for WASM + React dev eval):

```
NEXT_PUBLIC_CSP_DEV=1
# Optional ord overrides (per network); legacy NEXT_PUBLIC_ORD_BASE also accepted:
# NEXT_PUBLIC_ORD_BASE_SIGNET=http://127.0.0.1:8080
# Legacy testnet4 env still works as a fallback for signet:
# NEXT_PUBLIC_ORD_BASE_TESTNET=http://127.0.0.1:8080
# NEXT_PUBLIC_ORD_BASE_MAINNET=https://ordinals.com
```

Configured ord origins are automatically added to the CSP `connect-src`.

Run the test suite:

```bash
npm test         # 177 tests
```

---

## How it works

```
COMMIT-REVEAL (all three modes)

  +--------+      +-------------------+      +---------------------+      +-----------------------------+
  | User   | ---> | COMMIT TX         | ---> | Wait                | ---> | REVEAL TX                   |
  | signs  |      | P2TR output       |      | for 5 confirmations |      | reveals rune (+ inscription)|
  | PSBT   |      | commits to the    |      | (lands at conf #6,  |      | spends + returns the parent |
  |        |      | rune name +       |      |  the protocol min)  |      | (Parent Child mode)         |
  |        |      | reveal budget     |      |                     |      |                             |
  +--------+      +-------------------+      +---------------------+      +-----------------------------+
```

All transaction building happens in the browser with `bitcoinjs-lib`. Private keys live exclusively in the wallet extension and never reach the page.

---

## Tech Stack

| Layer | Tech |
|---|---|
| Framework | Next.js 16 (App Router) + React 19 |
| Styling | Tailwind 4 |
| State | Zustand 5 (BigInt + Uint8Array-safe persistence) |
| Bitcoin TX | `bitcoinjs-lib` 7.0.1 (pinned exact) + `tiny-secp256k1` |
| Wallets | `sats-connect` 4.2.1 (Xverse) + direct Leather provider |
| Tests | Vitest 4 + Testing Library |

Backend: none. Everything runs in the browser.

---

## Security

This is a self-custodial tool — funds flow through it. See [`SECURITY.md`](./SECURITY.md) for the security model, fund-critical guarantees, the dependency-pin rationale, the audit history (including the parent-return fund-loss bug found in end-to-end testing and fixed), and how to report a vulnerability.

---

## Project Structure

```
runes-etch/
├── src/
│   ├── app/          Next.js routes — / is the builder
│   ├── components/
│   │   └── builder/  Three-mode etching builder + phase components
│   ├── lib/
│   │   ├── api/      mempool.space/emzy + ord clients, ord-health probe
│   │   ├── bundle/   Bundle export/import for recovery
│   │   ├── runes/    Name validation, cenotaph gates, TX construction
│   │   ├── vanity/   Web Worker TXID grinder
│   │   └── wallet/   Xverse + Leather provider abstractions
│   ├── store/        Zustand store (persisted)
│   └── types/
├── SECURITY.md       Security model + audit history
└── LICENSE           MIT
```

The earlier step-by-step wizard has been retired; the single-page builder is the only app surface.

---

## License

[MIT](./LICENSE)

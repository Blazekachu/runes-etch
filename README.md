# Runes Etch

**Self-custodial Bitcoin Runes etching tool.** Web-based, client-side only, no backend. Etch new runes on Bitcoin mainnet or testnet4 with vanity TXID grinding, parent inscriptions, and bundle recovery — without ever giving up your keys.

> Status: testnet4-validated across all 4 modes · 5 security audits · 57 tests passing · production-ready

---

## Features

### Four Etching Modes

| Mode | What it does | Front-run protection |
|---|---|---|
| **Quick** | Single-TX rune etch — fastest, simplest | None (mempool visible) |
| **No-inscription** | Commit-reveal etch with name commitment, no inscription | Name protected via tapscript |
| **No-parent** | Commit-reveal with inscription, no parent | Name + inscription protected |
| **Full** | Commit-reveal with inscription **and** parent (child-of) | Name + inscription + parent |

### Vanity TXID Grinding

Grind your etch TXID to start (or end) with chosen hex characters. Works in **all 4 modes**.

- Up to 6 hex characters (~16M attempts at 8 chars = practical ceiling)
- Web Worker grinder — UI stays responsive
- Cached tapscript ensures the grinded TXID matches the actual reveal TX
- Fee rate locks after grinding (changing fee would invalidate the vanity locktime)

### Bundle Recovery

- Export your in-progress etch as a JSON bundle at any point
- Import it later to resume — survives page refresh, browser change, days of waiting
- Tapscript / control-block / internal-pubkey cached in the bundle so vanity work isn't lost

### Wallet Support

- **Xverse** — via `sats-connect` (also picks Unisat, Fordefi)
- **Leather** — direct `window.LeatherProvider` integration
- Provider choice persists across sessions
- Reconnect prompt when wallet disconnects after refresh

### Smart UTXO Selection

- Shows estimated cost (commit + reveal + dust) before you pick
- Auto-selects minimum UTXOs by default — largest first, payment-type preferred
- Live funding progress bar (green when funded, orange with deficit shown)

---

## Quick Start

```bash
npm install
npm run dev
```

Then open <http://localhost:3000>. For dev mode with CSP override (required for WASM + React eval), create `.env.local`:

```
NEXT_PUBLIC_CSP_DEV=1
```

Test:

```bash
npm test         # 57 tests
```

---

## How It Works

```
COMMIT-REVEAL MODE (no-inscription / no-parent / full)
+--------+      +------------+       +--------+
| User   | ---> | COMMIT TX  | ----> | Wait   |
| signs  |      | (tapscript |       | for    |
| PSBT   |      |  commits   |       | conf   |
|        |      |  to name)  |       |        |
+--------+      +------------+       +--------+
                                          |
                                          v
                                   +-------------+
                                   | REVEAL TX   |
                                   | (reveals    |
                                   |  rune +     |
                                   |  inscription|
                                   |  optionally |
                                   |  spends     |
                                   |  parent)    |
                                   +-------------+

QUICK MODE
+--------+      +------------+
| User   | ---> | SINGLE TX  |
| signs  |      | (rune +    |
| PSBT   |      |  runestone)|
+--------+      +------------+
```

All transaction building happens in the browser using `bitcoinjs-lib`. Private keys live exclusively in the wallet extension and never reach the page.

---

## Address Routing

Runes Etch always routes outputs deterministically:

- **Runes + inscriptions** → user's taproot address (ordinals address)
- **Parent inscription** (Full mode) → returned to user's taproot address (not the payment/change address)
- **Change** → user's payment/change address (typically segwit)

This matches the standard Bitcoin ordinals + runes protocol convention and prevents accidentally sending ordinals to a segwit-only address.

---

## Testnet4 Support

Auto-detects testnet from the wallet's address prefix (`tb1`). Adjustments on testnet:

- Mempool API: tries `mempool.space/testnet4` first, falls back to `testnet`
- Rune name unlock validation skipped (block height below mainnet activation)
- `ordinals.com` checks skipped (mainnet-only API), uses mempool instead
- Leather returns segwit only on testnet — app handles gracefully

All 4 modes have been etched and confirmed on testnet4.

---

## Tech Stack

| Layer | Tech |
|---|---|
| Framework | Next.js 16 (App Router) + React 19 |
| Styling | Tailwind 4 |
| State | Zustand 5 (with BigInt + Uint8Array safe JSON serialization) |
| Bitcoin TX | `bitcoinjs-lib` 7.0.1 (pinned exact) + `tiny-secp256k1` |
| Wallets | `sats-connect` 4.2.1 (Xverse) + direct Leather provider |
| Tests | Vitest 4 + Testing Library |

Backend: none. Everything runs in the browser.

---

## Security

Five complete security audits — 0 fund-loss bugs, 0 key leaks, 0 injection vectors.

See [`SECURITY.md`](./SECURITY.md) for the full security model, guarantees, accepted trade-offs, and dependency pin rationale.

---

## Project Structure

```
runes-etch/
├── src/
│   ├── app/          Next.js routes — /etch is the main flow
│   ├── components/
│   │   └── wizard/   Step-by-step etching wizard (6–9 steps per mode)
│   ├── lib/
│   │   ├── api/      mempool.space + ordinals.com clients
│   │   ├── bundle/   Bundle export/import for recovery
│   │   ├── runes/    Rune name validation + TX construction
│   │   ├── vanity/   Web Worker TXID grinder
│   │   └── wallet/   Xverse + Leather provider abstractions
│   ├── store/        Zustand store (persisted)
│   └── types/
├── SECURITY.md       Security model + audit summary
└── LICENSE           MIT
```

A v2 single-page builder is under active development on the [`feat/etch-v2`](../../tree/feat/etch-v2) branch.

---

## License

[MIT](./LICENSE)

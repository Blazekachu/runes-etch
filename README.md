# Runes Etch

**Self-custodial Bitcoin Runes etching tool.** Web-based, client-side only, no backend. Etch new runes on Bitcoin mainnet or testnet4 with vanity TXID grinding, parent inscriptions, and bundle recovery — without ever giving up your keys.

> Status: v2 three-mode flow in progress · 5 security audits · 139 tests passing · testnet4 re-validation pending

---

## Features

### Three Etching Modes

| Mode | What it does | Front-run protection |
|---|---|---|
| **Parent Child** | Commit-reveal rune etch with a new child inscription linked to a parent inscription. Child content can be file, text, or delegate. | Name + child inscription + parent |
| **Rune With Inscription** | Commit-reveal rune etch with file, text, or delegate inscription content and no parent lineage. | Name + inscription |
| **Rune** | Commit-reveal rune etch with rune name, supply, mint terms, turbo, and no inscription or parent. | Name |

### Vanity TXID Grinding

Grind your etch TXID to start (or end) with chosen hex characters. Works in all three modes.

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

The current v2 three-mode flow is being prepared for a fresh testnet4 validation pass.

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
│   ├── app/          Next.js routes — / is the main v2 flow
│   ├── components/
│   │   └── builder/  Three-mode etching builder
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

The old wizard flow has been retired; the v2 builder is the standalone app surface.

---

## License

[MIT](./LICENSE)

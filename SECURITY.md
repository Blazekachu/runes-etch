# Runes Etch — Security

This is a self-custodial Bitcoin tool. Funds flow through it; bugs can cost users money. Security is taken seriously.

## Audit Status

Five complete security audits performed across all 33 source files. Findings:

| Category | Bugs Found |
|---|---|
| Fund-loss bugs | **0** |
| Private-key leaks | **0** |
| Injection / XSS vectors | **0** |

Validation: 57 tests passing, testnet4-validated across all 4 etching modes (Quick, No-inscription, No-parent, Full).

## Fund-Critical Guarantees

Every fund-critical path is guarded:

- Rune name re-checked before every broadcast (commit, reveal, quick) — 3 separate validation sites
- Commit UTXO verified before reveal — prevents broadcasting a reveal against a non-existent commit
- Double-click guard (`broadcastingRef`) on every broadcast button
- Double-commit prevention — can't run two commits for the same etch
- Mode locked after first commit — can't switch from Full → Quick mid-etch
- Insufficient funds throws **before** signing (no half-signed PSBTs)
- Dust-change warning before broadcast
- Quick-etch validates rune name is fully unlocked (block height check)
- Premine includes a dust output so the runes don't burn on the runestone

## Private-Key Guarantees

Private keys never leave the user's wallet extension:

- Xverse via `sats-connect` RPC — wallet signs PSBTs internally
- Leather via `window.LeatherProvider` — same RPC pattern, no key exposure
- Public keys validated (hex, 32/33 bytes) before any cryptographic use
- No private key stored in `localStorage`, bundle exports, or React state
- PSBTs contain only public data until the wallet signs them

## XSS / Injection Defenses

- CSP blocks all external scripts (`script-src 'self'`)
- `connect-src` limited to `mempool.space` and `ordinals.com`
- `frame-ancestors 'none'` blocks clickjacking
- Broadcast error messages HTML-sanitized
- All API inputs regex-validated before use
- Zero `dangerouslySetInnerHTML` calls in the codebase
- Zero `eval()` in production (dev-mode only behind `NEXT_PUBLIC_CSP_DEV=1`)

## Known Accepted Trade-offs

These are documented limits, not bugs:

- **Front-running risk on Quick mode** — Quick etch has no front-run protection (rune commitment happens in a single TX, visible in mempool). Commit-reveal modes protect the name via tapscript commitment.
- **bitcoinjs-lib internal API dependency** — Uses `__CACHE.__TX` for locktime/TXID computation. Pinned to exact `7.0.1` (not `^7.0.1`) — upgrades will break vanity grinding.
- **Fee estimation is approximate** — Conservative (rounds up), so the error direction is safe.
- **Vanity grinder is probabilistic** — 6 hex characters maximum; UI shows difficulty estimate before grinding.
- **Leather on testnet returns no taproot** — Wallet returns segwit only on testnet. App handles this gracefully; mainnet should return proper taproot.

## Dependency Pins

| Package | Version | Why pinned |
|---|---|---|
| `bitcoinjs-lib` | `7.0.1` (exact) | `__CACHE.__TX` API dependency |
| `tiny-secp256k1` | `^2.2.4` | WASM ECC |
| `sats-connect` | `^4.2.1` | Wallet RPC protocol |
| `next` | `16.2.6` | Framework |
| `react` | `19.2.4` | UI |
| `zustand` | `^5.0.13` | State management |

## Reporting a Vulnerability

If you find a security issue:

- **Fund-loss or key-leak risks** — please report privately to the maintainer (see repo profile for contact). Do not open a public issue.
- **Other findings (UX, CSP gaps, dependency advisories)** — a public issue marked `[security]` is fine.

Responsible disclosure window: 90 days from acknowledgement before public discussion of fund-critical findings.

# Runes Etch — Security

This is a self-custodial Bitcoin tool. Funds flow through it; bugs can cost users money. Security is taken seriously.

## Audit Status

Five complete static security audits were performed on the earlier (wizard) codebase — finding 0 key-leak and 0 injection/XSS vectors. The tool was then **rewritten into the v2 three-mode commit-reveal builder**, and the old wizard removed.

**A fund-loss bug was subsequently found in end-to-end testing and fixed:** in Parent Child mode the parent inscription could be carried into the transaction's fee tail (lost to the miner) because the parent input/output were not ordered ahead of the commit sats. It is fixed by placing the parent as the **first input** and its return as the **first output**, so the parent sat is always assigned to the return output before any other sats. The incident is the reason "tx confirmed ≠ rune/parent safe" is now an explicit verification step.

| Category | Status |
|---|---|
| Private-key leaks | none found |
| Injection / XSS vectors | none found |
| Fund-loss bugs | one found in e2e (parent → fee tail) — **fixed**; full re-audit pending |

Validation: **160 automated tests passing**, `tsc` + production build clean. The current v2 three-mode flow is undergoing a fresh testnet4 end-to-end validation pass and a re-audit of the rewritten transaction-building code.

## Fund-Critical Guarantees

Every fund-critical path is guarded:

- **Cenotaph protection** — rune name re-checked before the commit *and* again immediately before the reveal. The reveal is blocked when the name is already etched, when the indexer can't be trusted (lagging / wedged on a reorg), or when the name is still below the chain's current minimum (with the exact unlock block shown; advanced override required to proceed).
- **Reveal timing** — reveal unlocks only at 5 commit confirmations, landing at the protocol-required 6th.
- **Parent never lost** — in Parent Child mode the parent inscription is the first input and first output, so its sat is returned to the user's taproot and can never fall into the fee tail.
- **Vanity TXID verified before broadcast** — after signing, the final commit/reveal TXID is re-checked against the requested prefix/suffix; broadcast is refused on any mismatch.
- Commit UTXO / commitment verified before the reveal is built — no reveal against a non-existent or stale commit.
- Double-click guard (`broadcastingRef`) on every broadcast button.
- Double-commit prevention — can't run two commits for the same etch; mode is locked once a commit exists.
- Insufficient funds throws **before** signing (no half-signed PSBTs).
- Dust-change warning before broadcast; premine always gets a dust output so runes aren't burned on the runestone.
- Resilient providers — `mempool.space` falls over to `mempool.emzy.de` for reads **and broadcast** so a provider outage can't strand a signed transaction.

## Private-Key Guarantees

Private keys never leave the user's wallet extension:

- Xverse via `sats-connect` RPC — wallet signs PSBTs internally
- Leather via `window.LeatherProvider` — same RPC pattern, no key exposure
- Public keys validated (hex, 32/33 bytes) before any cryptographic use
- No private key stored in `localStorage`, bundle exports, or React state
- PSBTs contain only public data until the wallet signs them

## XSS / Injection Defenses

- CSP blocks all external scripts (`script-src 'self'`)
- `connect-src` limited to `mempool.space` (+ subdomains), `mempool.emzy.de`, `ordinals.com`, and any explicitly configured ord origin (auto-added from `NEXT_PUBLIC_ORD_BASE*`)
- `frame-ancestors 'none'` blocks clickjacking
- Broadcast error messages HTML-sanitized
- All API inputs regex-validated before use
- Zero `dangerouslySetInnerHTML` calls in the codebase
- Zero `eval()` in production (dev-mode only behind `NEXT_PUBLIC_CSP_DEV=1`)

## Known Accepted Trade-offs

These are documented limits, not bugs:

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

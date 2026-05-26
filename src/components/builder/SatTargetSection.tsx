'use client';

import { useBuilderStore } from '@/store/builderStore';
import { resolveTarget, type ResolveTargetInput } from '@/lib/api/ordinals';
import SectionWrapper from './SectionWrapper';

const SAT_NUMBER_RE = /^\d{1,20}$/;
const INSCRIPTION_ID_RE = /^[0-9a-fA-F]{64}i\d+$/;

/**
 * Optional manual-entry target for the etch's vin[0]. Users with hoarder taproot
 * addresses (where /utxo and /txs walks fail or stall) can name a specific sat
 * or inscription instead of picking from an enumerated list. ord resolves the
 * input with one HTTP call; verified target becomes vin[0] at build time.
 *
 * When left blank → builder uses payment UTXOs only (fresh etch, no specific
 * sat target). This is the path users without taproot enumeration take.
 */
export default function SatTargetSection() {
  const wallet = useBuilderStore((s) => s.wallet);
  const targetInput = useBuilderStore((s) => s.targetInput);
  const setTargetInput = useBuilderStore((s) => s.setTargetInput);
  const targetUtxo = useBuilderStore((s) => s.targetUtxo);
  const setTargetUtxo = useBuilderStore((s) => s.setTargetUtxo);
  const targetVerifyState = useBuilderStore((s) => s.targetVerifyState);
  const setTargetVerifyState = useBuilderStore((s) => s.setTargetVerifyState);
  const targetVerifyError = useBuilderStore((s) => s.targetVerifyError);
  const setTargetVerifyError = useBuilderStore((s) => s.setTargetVerifyError);

  // Parse input into either a sat number or an inscription ID.
  function parseInput(raw: string): ResolveTargetInput | null {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    if (INSCRIPTION_ID_RE.test(trimmed)) {
      return { kind: 'inscription', inscriptionId: trimmed.toLowerCase() };
    }
    if (SAT_NUMBER_RE.test(trimmed)) {
      const n = Number(trimmed);
      if (Number.isFinite(n) && n >= 0 && n <= Number.MAX_SAFE_INTEGER) {
        return { kind: 'sat', satNumber: n };
      }
    }
    return null;
  }

  async function handleVerify() {
    const parsed = parseInput(targetInput);
    if (!parsed) {
      setTargetVerifyState('error');
      setTargetVerifyError('Enter a sat number (digits) or inscription ID (<64-hex>i<index>).');
      setTargetUtxo(null);
      return;
    }
    if (!wallet.taprootAddress) {
      setTargetVerifyState('error');
      setTargetVerifyError('Connect your wallet first — we verify the target is in your taproot address.');
      setTargetUtxo(null);
      return;
    }

    setTargetVerifyState('verifying');
    setTargetVerifyError('');
    setTargetUtxo(null);

    const result = await resolveTarget(parsed, wallet.taprootAddress);

    switch (result.status) {
      case 'ok':
        setTargetUtxo({
          txid: result.txid,
          vout: result.vout,
          value: result.value,
          satNumber: result.satNumber,
          inscriptionIds: result.inscriptionIds,
          runeNames: result.runeNames,
        });
        setTargetVerifyState('ok');
        break;
      case 'not-owned':
        setTargetVerifyState('error');
        setTargetVerifyError(
          `You need to hold this in your wallet to etch on it. Sat #${result.satNumber} is currently at ` +
          `${truncateAddr(result.currentAddress)} — not your taproot.`,
        );
        break;
      case 'wrong-offset':
        setTargetVerifyState('error');
        setTargetVerifyError(
          `Sat #${result.satNumber} is at offset ${result.offset.toLocaleString()} of its UTXO, not 0. ` +
          `The etch's inscription/rune lands on the FIRST sat of vin[0], so this target sat must be at offset 0. ` +
          `Split the UTXO in an ord-aware wallet first, then retry.`,
        );
        break;
      case 'not-found':
        setTargetVerifyState('error');
        setTargetVerifyError(
          `Not found via ord: ${result.reason}. The sat may not yet have been touched on-chain, or ord ` +
          `is unavailable.`,
        );
        break;
    }
  }

  function handleClear() {
    setTargetInput('');
    setTargetUtxo(null);
    setTargetVerifyState('idle');
    setTargetVerifyError('');
  }

  function handleInputChange(v: string) {
    setTargetInput(v);
    // Editing invalidates a previous verify result so user must re-verify.
    if (targetVerifyState !== 'idle') {
      setTargetVerifyState('idle');
      setTargetVerifyError('');
      setTargetUtxo(null);
    }
  }

  const verifying = targetVerifyState === 'verifying';
  const verified = targetVerifyState === 'ok' && !!targetUtxo;
  const errored = targetVerifyState === 'error';

  let badge: string | undefined;
  if (verified && targetUtxo) {
    badge = targetUtxo.inscriptionIds.length > 0
      ? `reinscribe on sat ${targetUtxo.satNumber}`
      : `target sat ${targetUtxo.satNumber}`;
  }

  return (
    <SectionWrapper sectionKey="sat-target" title="Target sat or inscription" badge={badge}>
      <div className="flex flex-col gap-3">
        <p className="text-xs text-gray-500">
          <span className="text-gray-300">Optional.</span> Leave blank for a fresh etch on
          any sat (the inscription/rune will land on the first sat of your selected payment
          UTXO). To etch on a SPECIFIC sat or reinscribe on an EXISTING inscription, paste
          the sat number or inscription ID below — we verify ownership via ord without
          enumerating your full taproot UTXO set.
        </p>

        <div className="flex gap-2">
          <input
            type="text"
            value={targetInput}
            onChange={(e) => handleInputChange(e.target.value)}
            placeholder="Sat number (e.g. 1234567890) or inscription ID (abc…i0)"
            spellCheck={false}
            className="flex-1 rounded-lg border border-gray-700 bg-gray-900 px-4 py-2.5 font-mono text-xs text-white placeholder-gray-600 focus:border-orange-500 focus:outline-none"
          />
          <button
            onClick={handleVerify}
            disabled={verifying || !targetInput.trim() || !wallet.taprootAddress}
            className="rounded-lg border border-orange-500 px-4 py-2.5 text-sm font-semibold text-orange-500 hover:bg-orange-500 hover:text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors whitespace-nowrap"
          >
            {verifying ? 'Verifying…' : 'Verify'}
          </button>
          {(verified || errored || targetInput) && (
            <button
              onClick={handleClear}
              className="rounded-lg border border-gray-700 px-3 py-2.5 text-xs text-gray-400 hover:text-white hover:border-gray-500 transition-colors"
            >
              Clear
            </button>
          )}
        </div>

        {verified && targetUtxo && (
          <div className="rounded-lg border border-green-500/30 bg-green-500/10 px-4 py-3 flex flex-col gap-1">
            <span className="text-xs text-green-400 font-semibold">
              ✓ Verified — target is in your taproot at offset 0
            </span>
            <span className="text-xs text-gray-300 font-mono break-all">
              UTXO: {targetUtxo.txid}:{targetUtxo.vout} · {targetUtxo.value.toLocaleString()} sats
            </span>
            <span className="text-xs text-gray-400">
              Sat #{targetUtxo.satNumber.toLocaleString()} — will be vin[0] of the commit.
            </span>
            {targetUtxo.inscriptionIds.length > 0 && (
              <span className="text-xs text-purple-300">
                ★ Reinscription detected: this sat already carries{' '}
                {targetUtxo.inscriptionIds.length === 1
                  ? '1 inscription'
                  : `${targetUtxo.inscriptionIds.length} inscriptions`}
                . The new etch will stack on the same sat.
              </span>
            )}
            {targetUtxo.runeNames.length > 0 && (
              <span className="text-xs text-orange-300">
                Note: this UTXO also holds rune balance ({targetUtxo.runeNames.join(', ')}).
                It carries forward to the new output by default.
              </span>
            )}
          </div>
        )}

        {errored && (
          <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3">
            <span className="text-xs text-red-400">{targetVerifyError}</span>
          </div>
        )}
      </div>
    </SectionWrapper>
  );
}

function truncateAddr(a: string): string {
  if (a.length <= 18) return a;
  return `${a.slice(0, 10)}…${a.slice(-6)}`;
}

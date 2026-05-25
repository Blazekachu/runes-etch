'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { useBuilderStore } from '@/store/builderStore';
import { getTxConfirmations, bitcoinNetworkForAddress, setMempoolNetwork, fetchFeeRates } from '@/lib/api/mempool';
import { setOrdinalsTestnet } from '@/lib/api/ordinals';
import { connectWallet, getActiveProvider } from '@/lib/wallet/xverse';
import { createCommitBundle, downloadBundle } from '@/lib/bundle/export';
import { buildTapscript, buildBareTapscript } from '@/lib/runes/inscription';
import { runeNameToCommitmentBytes } from '@/lib/runes/names';
import { buildRevealTx, serializeForTxid } from '@/lib/runes/reveal';
import { VanityGrinder } from '@/lib/vanity/grinder';
import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';

bitcoin.initEccLib(ecc);

const REQUIRED_CONFIRMATIONS = 6;
const POLL_INTERVAL_MS = 15_000;
function mempoolTxUrl(address: string): string {
  if (address.startsWith('tb1') || address.startsWith('2') || address.startsWith('m') || address.startsWith('n')) {
    return 'https://mempool.space/testnet4/tx';
  }
  return 'https://mempool.space/tx';
}

export default function WaitingPhase() {
  const commitState = useBuilderStore((s) => s.commitState);
  const updateCommitConfirmations = useBuilderStore((s) => s.updateCommitConfirmations);
  const vanityConfig = useBuilderStore((s) => s.vanityConfig);
  const setVanityConfig = useBuilderStore((s) => s.setVanityConfig);
  const vanityProgress = useBuilderStore((s) => s.vanityProgress);
  const etching = useBuilderStore((s) => s.etching);
  const wallet = useBuilderStore((s) => s.wallet);
  const inscriptionFile = useBuilderStore((s) => s.inscriptionFile);
  const delegateInscriptionId = useBuilderStore((s) => s.delegateInscriptionId);
  const parentInscription = useBuilderStore((s) => s.parentInscription);
  const bundleDownloaded = useBuilderStore((s) => s.bundleDownloaded);
  const setBundleDownloaded = useBuilderStore((s) => s.setBundleDownloaded);
  const setVanityProgress = useBuilderStore((s) => s.setVanityProgress);
  const setVanityLocktime = useBuilderStore((s) => s.setVanityLocktime);
  const selectedFeeRate = useBuilderStore((s) => s.selectedFeeRate);
  const selectedRevealFeeRate = useBuilderStore((s) => s.selectedRevealFeeRate);
  const setSelectedFeeRate = useBuilderStore((s) => s.setSelectedFeeRate);
  const feeRatesFromStore = useBuilderStore((s) => s.feeRates);
  const setFeeRatesStore = useBuilderStore((s) => s.setFeeRates);
  const setWallet = useBuilderStore((s) => s.setWallet);

  // hasInscription: determined from store state, not etchMode
  const hasInscription = !!useBuilderStore.getState().inscriptionFile || !!useBuilderStore.getState().delegateInscriptionId;

  const cachedTapscriptHex = useBuilderStore((s) => s.cachedTapscriptHex);
  const cachedControlBlockHex = useBuilderStore((s) => s.cachedControlBlockHex);
  const cachedInternalPubkeyHex = useBuilderStore((s) => s.cachedInternalPubkeyHex);

  // changeAddress is a function in builderStore
  const getChangeAddress = useBuilderStore((s) => s.changeAddress);

  const [pollError, setPollError] = useState<string | null>(null);
  const [vanitySkipped, setVanitySkipped] = useState(false);
  const [grindError, setGrindError] = useState<string | null>(null);
  const [bundleError, setBundleError] = useState<string | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  const [feeMode, setFeeMode] = useState<'economy' | 'normal' | 'fast' | 'custom'>('normal');
  const [customRate, setCustomRate] = useState('');
  const [loadingFees, setLoadingFees] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const grinderRef = useRef<VanityGrinder | null>(null);
  const grindStartedRef = useRef(false);

  const needsReconnect = !wallet.publicKey;

  const confirmations = commitState?.confirmations ?? 0;
  const txid = commitState?.txid ?? '';

  const hasVanity = vanityConfig.prefix.length > 0 || vanityConfig.suffix.length > 0;
  const vanityReady = !hasVanity || vanityProgress.found || vanitySkipped;
  const canProceed = confirmations >= REQUIRED_CONFIRMATIONS && vanityReady && !needsReconnect;

  // Estimated blocks remaining and time
  const blocksRemaining = Math.max(0, REQUIRED_CONFIRMATIONS - confirmations);
  const minutesRemaining = blocksRemaining * 10;

  useEffect(() => {
    if (!txid) return;

    async function poll() {
      try {
        const confs = await getTxConfirmations(txid);
        updateCommitConfirmations(confs);
        setPollError(null);
        if (confs >= REQUIRED_CONFIRMATIONS && intervalRef.current) {
          clearInterval(intervalRef.current);
          intervalRef.current = null;
        }
      } catch (err) {
        setPollError(err instanceof Error ? err.message : 'Failed to check confirmations');
      }
    }

    poll();
    intervalRef.current = setInterval(poll, POLL_INTERVAL_MS);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [txid]);

  // --- Vanity grinding via nLockTime ---
  // CRITICAL: This template must produce the EXACT same TX serialization as
  // the reveal phase. Both must use the same tapscript, controlBlock,
  // internalPubkey, feeRate, addresses, and etching params. The only difference is
  // the locktime field which the grinder varies.

  const buildTxTemplate = useCallback((): { template: Uint8Array | null; error?: string } => {
    if (!commitState || !wallet.publicKey) return { template: null, error: 'Wallet not connected.' };
    // Bundle-resume race: phase flips to 'waiting' before etching is fully populated, or
    // a previous reset left runeName empty. Bail out gracefully — runeNameToU128 throws
    // on '' and would crash the page during template build.
    if (!etching.runeName) return { template: null, error: 'Rune name not yet loaded.' };

    // Use cached tapscript data — same source the reveal phase will use
    const tsHex = cachedTapscriptHex;
    const cbHex = cachedControlBlockHex;
    const pkHex = cachedInternalPubkeyHex;

    if (!tsHex || !cbHex || !pkHex) {
      // Fallback: derive from wallet pubkey if no cache (normal flow without bundle)
      try {
        if (!/^[0-9a-f]+$/i.test(wallet.publicKey)) return { template: null, error: 'Invalid public key.' };
        const fullPubkey = Buffer.from(wallet.publicKey, 'hex');
        const internalPubkey = fullPubkey.length === 33 ? fullPubkey.slice(1) : fullPubkey;
        const runeCommitment = runeNameToCommitmentBytes(etching.runeName);
        const btcNetwork = bitcoinNetworkForAddress(wallet.taprootAddress);

        let tapscript: Uint8Array;
        if (hasInscription && (inscriptionFile || delegateInscriptionId)) {
          tapscript = buildTapscript(internalPubkey, {
            contentType: inscriptionFile?.contentType ?? '',
            body: inscriptionFile?.body ?? new Uint8Array(0),
            parentId: parentInscription?.inscriptionId ?? null,
            delegateId: delegateInscriptionId,
            runeCommitment,
          });
        } else if (!hasInscription) {
          tapscript = buildBareTapscript(internalPubkey, runeCommitment);
        } else {
          return { template: null, error: 'Inscription file missing. Upload bundle to resume.' };
        }

        const scriptTree = { output: Buffer.from(tapscript) };
        const redeemPayment = bitcoin.payments.p2tr({
          internalPubkey, scriptTree,
          redeem: { output: Buffer.from(tapscript), redeemVersion: 0xc0 },
          network: btcNetwork,
        });
        const cbWitness = redeemPayment.witness;
        const controlBlock = cbWitness && cbWitness.length > 0
          ? Buffer.from(cbWitness[cbWitness.length - 1]) : Buffer.alloc(0);

        const { psbt } = buildRevealTx({
          etching, commitState, tapscript, controlBlock, internalPubkey,
          hasInscription,
          parentInscription: hasInscription ? parentInscription : null,
          additionalFundingUtxos: [],
          feeRate: selectedFeeRate,
          receiverAddress: wallet.taprootAddress,
          changeAddress: commitState?.changeAddress || wallet.taprootAddress,
          vanityNonce: new Uint8Array(0),
          network: btcNetwork,
        });
        return { template: serializeForTxid(psbt) };
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Unknown error';
        if (!msg.includes('Insufficient funds')) console.error('[WaitingPhase] buildTxTemplate failed:', err);
        return { template: null, error: msg };
      }
    }

    // Use cached data — matches what the reveal phase will use
    try {
      const tapscript = Buffer.from(tsHex, 'hex');
      const controlBlock = Buffer.from(cbHex, 'hex');
      const internalPubkey = Buffer.from(pkHex, 'hex');
      const btcNetwork = bitcoinNetworkForAddress(wallet.taprootAddress);

      const { psbt } = buildRevealTx({
        etching, commitState, tapscript, controlBlock, internalPubkey,
        hasInscription,
        parentInscription: hasInscription ? parentInscription : null,
        additionalFundingUtxos: [],
        feeRate: selectedFeeRate,
        receiverAddress: wallet.taprootAddress,
        changeAddress: commitState?.changeAddress || wallet.taprootAddress,
        vanityNonce: new Uint8Array(0),
        network: btcNetwork,
      });
      return { template: serializeForTxid(psbt) };
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      if (!msg.includes('Insufficient funds')) console.error('[WaitingPhase] buildTxTemplate failed:', err);
      return { template: null, error: msg };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [commitState?.txid, wallet.publicKey, etching.runeName, selectedFeeRate, cachedTapscriptHex]);

  useEffect(() => {
    if (!hasVanity || vanityProgress.found || vanitySkipped || grindStartedRef.current) return;
    if (!commitState || !wallet.publicKey) return;

    // Clear previous error when retrying
    setGrindError(null);

    // Stop any previous grinder before starting a new one
    if (grinderRef.current) {
      grinderRef.current.stop();
      grinderRef.current = null;
    }

    const { template, error: templateError } = buildTxTemplate();
    if (!template) {
      const hint = templateError?.includes('Insufficient funds')
        ? `${templateError} Lower the reveal fee rate below.`
        : templateError;
      setGrindError(hint || 'Cannot build TX template for grinding.');
      return;
    }

    grindStartedRef.current = true;
    const grinder = new VanityGrinder();
    grinderRef.current = grinder;

    grinder.start({
      txTemplate: template,
      nonceOffset: template.length - 4, // nLockTime = last 4 bytes
      nonceLength: 4,
      config: vanityConfig,
      onProgress: (progress) => {
        setVanityProgress(progress);
      },
      onFound: (nonce) => {
        // nonce is 4 bytes little-endian u32 = nLockTime value
        const dv = new DataView(nonce.buffer, nonce.byteOffset, nonce.byteLength);
        const lt = dv.getUint32(0, true);
        setVanityLocktime(lt);
      },
    });

    return () => {
      grinder.stop();
      grinderRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasVanity, vanityProgress.found, vanitySkipped, commitState?.txid, wallet.publicKey, vanityConfig.prefix, vanityConfig.suffix, selectedFeeRate]);

  async function handleReconnect() {
    setReconnecting(true);
    setGrindError(null);
    try {
      const w = await connectWallet(getActiveProvider());
      await setMempoolNetwork(w.taprootAddress);
      setOrdinalsTestnet(w.taprootAddress);
      setWallet(w);
      // Reset grind state so the effect re-triggers with new publicKey
      grindStartedRef.current = false;
    } catch (err) {
      setGrindError(err instanceof Error ? err.message : 'Failed to reconnect wallet');
    } finally {
      setReconnecting(false);
    }
  }

  async function loadFeeRates() {
    setLoadingFees(true);
    try {
      const rates = await fetchFeeRates();
      setFeeRatesStore(rates);
    } catch { /* ignore — fees already in store from earlier */ }
    finally { setLoadingFees(false); }
  }

  function resetVanityForNewFee() {
    setVanityProgress({ attempts: 0, speed: 0, bestMatch: '', found: false, nonce: null });
    setVanityLocktime(null);
    grindStartedRef.current = false;
  }

  // Upper bound for reveal fee rate: whatever was pre-funded into commit.vout[0]
  // (selectedRevealFeeRate from bundle/store). Null means unknown/legacy → no cap from
  // this side; insufficient-funds will surface at build time if user picks too high.
  const revealMaxRate = selectedRevealFeeRate ?? 2000;
  const clampReveal = (v: number): number => Math.max(1, Math.min(v, revealMaxRate));

  function handleFeeMode(mode: typeof feeMode) {
    setFeeMode(mode);
    if (!feeRatesFromStore) return;
    let raw = 0;
    if (mode === 'economy') raw = feeRatesFromStore.economyFee;
    else if (mode === 'normal') raw = feeRatesFromStore.halfHourFee;
    else if (mode === 'fast') raw = feeRatesFromStore.fastestFee;
    if (raw > 0) setSelectedFeeRate(clampReveal(raw));
    resetVanityForNewFee();
  }

  function handleCustomFeeRate(val: string) {
    setCustomRate(val);
    setFeeMode('custom');
    const v = parseInt(val, 10);
    if (!isNaN(v) && v >= 1) {
      setSelectedFeeRate(clampReveal(v));
      resetVanityForNewFee();
    }
  }

  function handleBundleDownload() {
    if (!commitState) return;
    try {
      if (!/^[0-9a-f]+$/i.test(wallet.publicKey)) return;
      const fullPubkey = Buffer.from(wallet.publicKey, 'hex');
      const internalPubkey = fullPubkey.length === 33 ? fullPubkey.slice(1) : fullPubkey;

      const runeCommitment = runeNameToCommitmentBytes(etching.runeName);
      let tapscript: Uint8Array;
      if (hasInscription && (inscriptionFile || delegateInscriptionId)) {
        tapscript = buildTapscript(internalPubkey, {
          contentType: inscriptionFile?.contentType ?? '',
          body: inscriptionFile?.body ?? new Uint8Array(0),
          parentId: parentInscription?.inscriptionId ?? null,
          delegateId: delegateInscriptionId,
          runeCommitment,
        });
      } else {
        tapscript = buildBareTapscript(internalPubkey, runeCommitment);
      }

      const scriptTree = { output: Buffer.from(tapscript) };
      const redeemPayment = bitcoin.payments.p2tr({
        internalPubkey,
        scriptTree,
        redeem: { output: Buffer.from(tapscript), redeemVersion: 0xc0 },
        network: bitcoinNetworkForAddress(wallet.taprootAddress),
      });
      const controlBlockWitness = redeemPayment.witness;
      const controlBlock = controlBlockWitness && controlBlockWitness.length > 0
        ? new Uint8Array(controlBlockWitness[controlBlockWitness.length - 1])
        : new Uint8Array(0);

      const bundle = createCommitBundle({
        commitState,
        runeName: etching.runeName,
        tapscript,
        controlBlock,
        internalPubkey: new Uint8Array(internalPubkey),
        inscriptionFile: hasInscription ? inscriptionFile : null,
        delegateInscriptionId: delegateInscriptionId,
        parentInscriptionId: parentInscription?.inscriptionId ?? null,
        etching,
        taprootAddress: wallet.taprootAddress,
        revealFeeRateBudget: selectedRevealFeeRate ?? undefined,
      });
      downloadBundle(bundle);
      setBundleDownloaded(true);
    } catch (err) {
      setBundleError(err instanceof Error ? err.message : 'Bundle download failed. Wallet may need reconnection.');
    }
  }

  function handleProceed() {
    useBuilderStore.getState().setPhase('reveal');
  }

  const progressPct = Math.min(100, (confirmations / REQUIRED_CONFIRMATIONS) * 100);

  function truncateTxid(t: string) {
    if (!t) return '\u2014';
    return `${t.slice(0, 10)}\u2026${t.slice(-10)}`;
  }

  return (
    <div className="flex flex-col gap-8 py-8 max-w-xl mx-auto w-full">
      <div>
        <h2 className="text-2xl font-bold text-white mb-1">Waiting for Confirmations</h2>
        <p className="text-gray-400 text-sm">
          The commit transaction has been broadcast. We need {REQUIRED_CONFIRMATIONS} confirmations before the reveal.
        </p>
      </div>

      {/* TXID */}
      <div className="rounded-lg border border-gray-800 bg-gray-900 px-4 py-3 flex items-center justify-between gap-4">
        <div className="min-w-0">
          <p className="text-xs text-gray-500 mb-0.5">Commit TXID</p>
          <p className="font-mono text-sm text-white truncate">{truncateTxid(txid)}</p>
        </div>
        {txid && (
          <a
            href={`${mempoolTxUrl(wallet.taprootAddress || wallet.paymentAddress)}/${txid}`}
            target="_blank"
            rel="noopener noreferrer"
            className="shrink-0 rounded-lg border border-gray-700 px-3 py-1.5 text-xs font-medium text-gray-400 hover:border-orange-500 hover:text-orange-400 transition-colors"
          >
            View
          </a>
        )}
      </div>

      {/* Confirmations progress */}
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between text-sm">
          <span className="text-gray-400">Confirmations</span>
          <span className="font-mono font-semibold text-white">
            {confirmations} / {REQUIRED_CONFIRMATIONS}
          </span>
        </div>

        {/* Progress bar */}
        <div className="h-3 rounded-full bg-gray-800 overflow-hidden">
          <div
            className="h-full rounded-full bg-orange-500 transition-all duration-700"
            style={{ width: `${progressPct}%` }}
          />
        </div>

        {/* Confirmation blocks */}
        <div className="flex gap-1.5">
          {Array.from({ length: REQUIRED_CONFIRMATIONS }).map((_, i) => (
            <div
              key={i}
              className={`flex-1 h-2 rounded-full transition-colors duration-500 ${
                i < confirmations ? 'bg-orange-500' : 'bg-gray-800'
              }`}
            />
          ))}
        </div>

        {confirmations < REQUIRED_CONFIRMATIONS ? (
          <p className="text-xs text-gray-500">
            ~{blocksRemaining} block{blocksRemaining !== 1 ? 's' : ''} remaining &nbsp;&bull;&nbsp; ~{minutesRemaining} min
          </p>
        ) : (
          <p className="text-xs text-green-400 font-medium">Fully confirmed</p>
        )}
      </div>

      {pollError && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-xs text-red-400">
          {pollError} — retrying every 15 seconds.
        </div>
      )}

      {/* Warning */}
      <div className="rounded-lg border border-yellow-500/30 bg-yellow-500/10 px-4 py-3 text-sm text-yellow-400">
        Do not spend from this wallet until the etch is complete.
      </div>

      {/* Vanity config + grinding status — unified section */}
      {!vanitySkipped && (
        <div className="flex flex-col gap-3 rounded-lg border border-gray-800 bg-gray-900 p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-gray-300">Vanity TXID <span className="text-gray-500 font-normal">(optional)</span></p>
              <p className="text-xs text-gray-500 mt-1">Hex only (0-9, a-f). Max 6 total. Grinding starts automatically.</p>
            </div>
            {hasVanity && (
              <button
                onClick={() => setVanitySkipped(true)}
                className="text-xs text-gray-500 hover:text-gray-300 transition-colors shrink-0"
              >
                Skip vanity
              </button>
            )}
          </div>

          {/* Inputs always visible — at typical CPU speeds short prefixes are found in
              milliseconds, so hiding inputs on "found" prevents the user from finishing
              their pattern. Editing either input resets the grind state. */}
          <div className="flex gap-4">
              <div className="flex flex-col gap-1 flex-1">
                <label className="text-xs text-gray-500 uppercase tracking-wider">Prefix</label>
                <input
                  type="text"
                  value={vanityConfig.prefix}
                  onChange={(e) => {
                    const clean = e.target.value.toLowerCase().replace(/[^0-9a-f]/g, '');
                    const maxLen = 6 - vanityConfig.suffix.length;
                    setVanityConfig({ ...vanityConfig, prefix: clean.slice(0, Math.max(0, maxLen)) });
                    setVanityProgress({ attempts: 0, speed: 0, bestMatch: '', found: false, nonce: null });
                    setVanityLocktime(null);
                    grindStartedRef.current = false;
                  }}
                  placeholder="dead"
                  spellCheck={false}
                  className="rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 font-mono text-sm text-white placeholder-gray-700 focus:border-orange-500 focus:outline-none"
                />
              </div>
              <div className="flex flex-col gap-1 flex-1">
                <label className="text-xs text-gray-500 uppercase tracking-wider">Suffix</label>
                <input
                  type="text"
                  value={vanityConfig.suffix}
                  onChange={(e) => {
                    const clean = e.target.value.toLowerCase().replace(/[^0-9a-f]/g, '');
                    const maxLen = 6 - vanityConfig.prefix.length;
                    setVanityConfig({ ...vanityConfig, suffix: clean.slice(0, Math.max(0, maxLen)) });
                    setVanityProgress({ attempts: 0, speed: 0, bestMatch: '', found: false, nonce: null });
                    setVanityLocktime(null);
                    grindStartedRef.current = false;
                  }}
                  placeholder="cafe"
                  spellCheck={false}
                  className="rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 font-mono text-sm text-white placeholder-gray-700 focus:border-orange-500 focus:outline-none"
                />
              </div>
            </div>

          {/* Grinding progress — shows inline when vanity is set */}
          {hasVanity && vanityProgress.found && (
            <div className="flex items-center gap-2 text-sm text-green-400 font-medium">
              <svg className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
              Vanity nonce found!
            </div>
          )}

          {hasVanity && !vanityProgress.found && (
            <>
              {grindError && (
                <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">
                  {grindError}
                </div>
              )}
              {!grindError && !needsReconnect && (
                <div className="flex flex-col gap-1.5 text-xs font-mono">
                  <div className="flex justify-between">
                    <span className="text-gray-500">Attempts</span>
                    <span className="text-gray-300">{vanityProgress.attempts.toLocaleString()}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-500">Speed</span>
                    <span className="text-gray-300">
                      {vanityProgress.speed > 0 ? `${vanityProgress.speed.toLocaleString()} h/s` : '\u2014'}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 text-gray-500">
                    <span className="inline-block w-2 h-2 rounded-full bg-orange-500 animate-pulse" />
                    Grinding nLockTime...
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* Fee rate selector */}
      <div className="flex flex-col gap-3 rounded-lg border border-gray-800 bg-gray-900 p-4">
        <div className="flex items-center justify-between">
          <p className="text-sm font-medium text-gray-300">Reveal Fee Rate</p>
          <button
            onClick={loadFeeRates}
            disabled={loadingFees}
            className="text-xs text-gray-500 hover:text-gray-300 disabled:opacity-40 transition-colors"
          >
            {loadingFees ? 'Loading...' : 'Refresh'}
          </button>
        </div>
        {selectedRevealFeeRate && (
          <p className="text-xs text-gray-500">
            Budget pre-funded at commit time: <span className="text-orange-400 font-mono">≤{selectedRevealFeeRate} sat/vB</span>.
            Pick less and the difference returns to your segwit as change.
          </p>
        )}
        <div className="flex gap-2">
          {(['economy', 'normal', 'fast'] as const).map((mode) => (
            <button
              key={mode}
              onClick={() => handleFeeMode(mode)}
              className={`flex-1 rounded-lg border px-3 py-2 text-sm font-semibold transition-colors ${
                feeMode === mode
                  ? 'border-orange-500 bg-orange-500/10 text-orange-400'
                  : 'border-gray-700 bg-gray-950 text-gray-400 hover:border-gray-600'
              }`}
            >
              <div className="capitalize">{mode}</div>
              {feeRatesFromStore && (
                <div className="text-xs font-mono opacity-70 mt-0.5">
                  {mode === 'economy' ? feeRatesFromStore.economyFee
                    : mode === 'normal' ? feeRatesFromStore.halfHourFee
                    : feeRatesFromStore.fastestFee} sat/vB
                </div>
              )}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-3">
          <input
            type="number"
            min={1}
            value={customRate}
            onChange={(e) => handleCustomFeeRate(e.target.value)}
            onFocus={() => setFeeMode('custom')}
            placeholder="Custom sat/vB"
            className={`flex-1 rounded-lg border px-3 py-2 font-mono text-sm text-white placeholder-gray-600 bg-gray-950 focus:outline-none transition-colors ${
              feeMode === 'custom' ? 'border-orange-500' : 'border-gray-700'
            }`}
          />
          <span className="text-sm text-gray-500 shrink-0">sat/vB</span>
        </div>
        <div className="flex items-center justify-between text-xs">
          <span className="text-gray-500">Selected</span>
          <span className="font-mono text-white font-semibold">{selectedFeeRate} sat/vB</span>
        </div>
      </div>

      {/* Reconnect prompt — needed after page refresh since publicKey is not persisted */}
      {needsReconnect && (
        <div className="flex flex-col gap-3 rounded-lg border border-yellow-500/30 bg-yellow-500/10 p-4">
          <p className="text-sm text-yellow-400">
            Wallet disconnected (page was refreshed). Reconnect to {hasVanity ? 'enable vanity grinding and ' : ''}sign the reveal.
          </p>
          <button
            onClick={handleReconnect}
            disabled={reconnecting}
            className="w-full rounded-lg bg-orange-500 hover:bg-orange-400 disabled:opacity-60 disabled:cursor-not-allowed px-4 py-2 text-sm font-semibold text-white transition-colors"
          >
            {reconnecting ? 'Connecting\u2026' : 'Reconnect Wallet'}
          </button>
        </div>
      )}

      {vanitySkipped && hasVanity && (
        <div className="rounded-lg border border-gray-700 bg-gray-900 px-4 py-3 text-sm text-gray-400">
          Vanity grinding skipped. A random nonce will be used.
        </div>
      )}

      {/* Bundle download */}
      <div className="rounded-lg border border-gray-800 bg-gray-900 p-4 flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-gray-300">Recovery Bundle</p>
            <p className="text-xs text-gray-500 mt-0.5">
              Download a backup file to resume this etch from any device.
            </p>
          </div>
          {bundleDownloaded && (
            <span className="text-xs text-green-400 font-medium shrink-0">Saved</span>
          )}
        </div>
        <button
          onClick={handleBundleDownload}
          className="w-full rounded-lg border border-gray-700 px-4 py-2 text-sm font-semibold text-gray-300 hover:border-orange-500 hover:text-orange-400 transition-colors"
        >
          {bundleDownloaded ? 'Download Again' : 'Download Bundle'}
        </button>
        {bundleError && (
          <p className="text-xs text-red-400">{bundleError}</p>
        )}
      </div>

      {/* Proceed button */}
      <div className="pt-2">
        <button
          onClick={handleProceed}
          disabled={!canProceed}
          className="w-full rounded-lg bg-orange-500 hover:bg-orange-400 active:bg-orange-600 disabled:opacity-40 disabled:cursor-not-allowed px-6 py-2.5 font-semibold text-white transition-colors"
        >
          {canProceed ? 'Proceed to Reveal' : `Waiting\u2026 (${confirmations}/${REQUIRED_CONFIRMATIONS} confirmations)`}
        </button>
      </div>
    </div>
  );
}

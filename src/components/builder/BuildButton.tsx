'use client';

import { useRef, useState, useEffect } from 'react';
import * as bitcoin from 'bitcoinjs-lib';
import { useBuilderStore } from '@/store/builderStore';
import { buildCommitTx } from '@/lib/runes/commit';
import { buildQuickEtchTx } from '@/lib/runes/quickEtch';
import { serializeForTxid } from '@/lib/runes/reveal';
import { signPsbt } from '@/lib/wallet/xverse';
import { broadcastTx, bitcoinNetworkForAddress, getCurrentBlockHeight } from '@/lib/api/mempool';
import { getRuneNameStatus } from '@/lib/api/ordinals';
import { VanityGrinder } from '@/lib/vanity/grinder';

export default function BuildButton() {
  const etching = useBuilderStore((s) => s.etching);
  const wallet = useBuilderStore((s) => s.wallet);
  const inscriptionFile = useBuilderStore((s) => s.inscriptionFile);
  const delegateInscriptionId = useBuilderStore((s) => s.delegateInscriptionId);
  const parentInscription = useBuilderStore((s) => s.parentInscription);
  const selectedFeeRate = useBuilderStore((s) => s.selectedFeeRate);
  const selectedRevealFeeRate = useBuilderStore((s) => s.selectedRevealFeeRate);
  const vanityConfig = useBuilderStore((s) => s.vanityConfig);
  const vanityProgress = useBuilderStore((s) => s.vanityProgress);
  const setVanityProgress = useBuilderStore((s) => s.setVanityProgress);
  const commitVanityConfig = useBuilderStore((s) => s.commitVanityConfig);
  const commitVanityProgress = useBuilderStore((s) => s.commitVanityProgress);
  const setCommitVanityProgress = useBuilderStore((s) => s.setCommitVanityProgress);
  const commitVanityLocktime = useBuilderStore((s) => s.commitVanityLocktime);
  const setCommitVanityLocktime = useBuilderStore((s) => s.setCommitVanityLocktime);
  const detectedMode = useBuilderStore((s) => s.detectedMode);
  const phase = useBuilderStore((s) => s.phase);
  const setPhase = useBuilderStore((s) => s.setPhase);
  const setCommitState = useBuilderStore((s) => s.setCommitState);
  const setCachedTapscript = useBuilderStore((s) => s.setCachedTapscript);
  const setQuickTxid = useBuilderStore((s) => s.setQuickTxid);
  const orderedFundingUtxos = useBuilderStore((s) => s.orderedFundingUtxos);
  const getChangeAddress = useBuilderStore((s) => s.changeAddress);
  const commitState = useBuilderStore((s) => s.commitState);
  const reinscribeMode = useBuilderStore((s) => s.reinscribeMode);
  const targetUtxo = useBuilderStore((s) => s.targetUtxo);
  const targetVerifyState = useBuilderStore((s) => s.targetVerifyState);
  const runeMinimum = useBuilderStore((s) => s.runeMinimum);

  const [loading, setLoading] = useState(false);
  const [grinding, setGrinding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dustConfirm, setDustConfirm] = useState<number | null>(null);

  // C5: Ref-based double-broadcast guard
  const broadcastingRef = useRef(false);
  const grinderRef = useRef<VanityGrinder | null>(null);

  // Cleanup grinder on unmount
  useEffect(() => {
    return () => { grinderRef.current?.stop(); };
  }, []);

  // Only visible during building phase
  if (phase !== 'building') return null;

  // Use the ordered list — primary UTXO is first, so it becomes vin 0 of commit/quick TX.
  // Inscription lands on the first sat of vin 0, so primary controls the rune/inscription's sat.
  const selected = orderedFundingUtxos();
  const hasVanity = vanityConfig.prefix.length > 0 || vanityConfig.suffix.length > 0;
  const isQuick = detectedMode === 'quick';

  // In reinscribe mode, the first input (primary, vin 0) MUST be an inscription UTXO so the
  // existing inscription's sat is the one carried into the commit output at offset 0.
  // Building with reinscribe ON but a plain primary would silently produce a fresh inscription
  // on a common sat, defeating the purpose. Block the build instead.
  //
  // When the user has set + verified a sat/inscription target, that target IS vin[0] regardless
  // of the picker, so this picker-side check is satisfied by definition.
  const reinscribePrimaryValid =
    !reinscribeMode ||
    (targetUtxo && targetVerifyState === 'ok') ||
    (selected.length > 0 && selected[0].label === 'inscription');

  // If the user entered a target but verification failed (not owned / wrong offset / not found),
  // refuse to build — the spec says: "show message and don't allow commit button to proceed".
  const targetBlocking = targetVerifyState === 'error';

  const canBuild =
    wallet.connected &&
    !!etching.runeName &&
    (selected.length > 0 || (targetUtxo && targetVerifyState === 'ok')) &&
    selectedFeeRate > 0 &&
    reinscribePrimaryValid &&
    !targetBlocking;

  function deriveInternalPubkey(): Buffer {
    if (!/^[0-9a-f]+$/i.test(wallet.publicKey)) {
      throw new Error('Invalid public key: not valid hex');
    }
    const fullPubkey = Buffer.from(wallet.publicKey, 'hex');
    if (fullPubkey.length !== 33 && fullPubkey.length !== 32) {
      throw new Error(`Invalid public key length: ${fullPubkey.length} bytes (expected 32 or 33)`);
    }
    return fullPubkey.length === 33 ? fullPubkey.slice(1) : fullPubkey;
  }

  function buildFundingUtxos() {
    const picker = selected.map((u) => ({
      ...u,
      address: u.source === 'payment' ? wallet.paymentAddress : wallet.taprootAddress,
    }));
    // Target sat/inscription, when verified, is prepended as vin[0] — its sat is
    // the one that flows to vout[0] (commit/quick output) and carries the inscription/rune.
    // Skip if the picker already includes the same outpoint (avoid double-input).
    if (targetUtxo && targetVerifyState === 'ok') {
      const dupIdx = picker.findIndex((u) => u.txid === targetUtxo.txid && u.vout === targetUtxo.vout);
      if (dupIdx >= 0) picker.splice(dupIdx, 1);
      return [
        {
          txid: targetUtxo.txid,
          vout: targetUtxo.vout,
          value: targetUtxo.value,
          status: { confirmed: true },
          address: wallet.taprootAddress,
        },
        ...picker,
      ];
    }
    return picker;
  }

  async function signAndBroadcastPsbt(psbt: bitcoin.Psbt, fee: number): Promise<string> {
    // Use the same input list the PSBT was built with so dust + sign-indices match
    // when a target UTXO is prepended as vin[0].
    const fundingInputs = buildFundingUtxos();

    // Dust change check
    const totalIn = fundingInputs.reduce((acc, u) => acc + BigInt(u.value), 0n);
    const changeValue = totalIn - BigInt(fee);
    if (changeValue > 0n && changeValue < 546n && dustConfirm !== Number(changeValue)) {
      setDustConfirm(Number(changeValue));
      setLoading(false);
      // Throw to interrupt; user must accept dust then re-click
      throw new DustConfirmNeeded();
    }

    const psbtBase64 = psbt.toBase64();
    const inputsToSign = fundingInputs.map((u, i) => ({
      index: i,
      address: u.address,
    }));

    const signedBase64 = await signPsbt(psbtBase64, inputsToSign);
    const signedPsbt = bitcoin.Psbt.fromBase64(signedBase64);
    signedPsbt.finalizeAllInputs();
    const finalTx = signedPsbt.extractTransaction();
    const txHex = finalTx.toHex();
    const txid = finalTx.getId();

    await broadcastTx(txHex);
    return txid;
  }

  // --- Quick Etch Flow ---
  async function handleQuickEtch() {
    const internalPubkey = deriveInternalPubkey();
    const fundingUtxos = buildFundingUtxos();
    const currentBlockHeight = await getCurrentBlockHeight();
    const btcNetwork = bitcoinNetworkForAddress(wallet.taprootAddress);
    const isTestnet = wallet.taprootAddress.startsWith('tb1');

    // If vanity is configured, grind for a matching nLockTime
    if (hasVanity) {
      setGrinding(true);
      broadcastingRef.current = false;
      setLoading(false);

      // Build template TX with locktime=0 to get serialization
      const templateResult = buildQuickEtchTx({
        etching, fundingUtxos, feeRate: selectedFeeRate,
        receiverAddress: wallet.taprootAddress, changeAddress: getChangeAddress(),
        internalPubkey, vanityNonce: new Uint8Array(0), currentBlockHeight, isTestnet,
        network: btcNetwork,
        runeMinimum,
      });
      const template = serializeForTxid(templateResult.psbt);

      const grinder = new VanityGrinder();
      grinderRef.current = grinder;

      grinder.start({
        txTemplate: template,
        nonceOffset: template.length - 4, // nLockTime = last 4 bytes
        nonceLength: 4,
        config: vanityConfig,
        onProgress: (progress) => setVanityProgress(progress),
        onFound: async (nonce) => {
          grinderRef.current = null;
          setGrinding(false);
          setLoading(true);
          broadcastingRef.current = true;

          try {
            const dv = new DataView(nonce.buffer, nonce.byteOffset, nonce.byteLength);
            const foundLocktime = dv.getUint32(0, true);

            // Rebuild TX with the winning locktime
            const finalResult = buildQuickEtchTx({
              etching, fundingUtxos, feeRate: selectedFeeRate,
              receiverAddress: wallet.taprootAddress, changeAddress: getChangeAddress(),
              internalPubkey, vanityNonce: new Uint8Array(0), currentBlockHeight, isTestnet,
              locktime: foundLocktime, network: btcNetwork,
              runeMinimum,
            });

            const txid = await signAndBroadcastPsbt(finalResult.psbt, finalResult.fee);
            setQuickTxid(txid);
            setPhase('complete');
          } catch (err) {
            if (!(err instanceof DustConfirmNeeded)) {
              setError(err instanceof Error ? err.message : 'An unknown error occurred.');
            }
          } finally {
            broadcastingRef.current = false;
            setLoading(false);
          }
        },
      });
      return;
    }

    // No vanity -- build and broadcast directly
    const result = buildQuickEtchTx({
      etching, fundingUtxos, feeRate: selectedFeeRate,
      receiverAddress: wallet.taprootAddress, changeAddress: getChangeAddress(),
      internalPubkey, vanityNonce: new Uint8Array(0), currentBlockHeight, isTestnet,
      network: btcNetwork,
      runeMinimum,
    });

    const txid = await signAndBroadcastPsbt(result.psbt, result.fee);
    setQuickTxid(txid);
    setPhase('complete');
  }

  // Shared finalize path: takes a built CommitTxResult + locktime context, signs,
  // broadcasts, and transitions to waiting. Factored out so the vanity-grind and
  // no-vanity paths can both reuse it.
  async function signAndBroadcastCommit(
    result: ReturnType<typeof buildCommitTx>,
    internalPubkey: Buffer,
  ): Promise<void> {
    if (result.dustChange > 0 && dustConfirm !== result.dustChange) {
      setDustConfirm(result.dustChange);
      setLoading(false);
      throw new DustConfirmNeeded();
    }

    const psbtBase64 = result.psbt.toBase64();
    // Sign indices must match the order in buildFundingUtxos (target UTXO at 0 when set).
    const fundingInputs = buildFundingUtxos();
    const inputsToSign = fundingInputs.map((u, i) => ({
      index: i,
      address: u.address,
    }));

    const signedBase64 = await signPsbt(psbtBase64, inputsToSign);
    const signedPsbt = bitcoin.Psbt.fromBase64(signedBase64);
    signedPsbt.finalizeAllInputs();
    const finalTx = signedPsbt.extractTransaction();
    const txHex = finalTx.toHex();
    const txid = finalTx.getId();

    await broadcastTx(txHex);

    setCommitState({
      txid,
      rawHex: txHex,
      confirmations: 0,
      commitOutputIndex: result.commitOutputIndex,
      commitOutputValue: result.commitOutputValue,
      changeAddress: getChangeAddress(),
    });

    const tapHex = Buffer.from(result.tapscript).toString('hex');
    const cbHex = Buffer.from(result.controlBlock).toString('hex');
    const pkHex = internalPubkey.toString('hex');
    setCachedTapscript(tapHex, cbHex, pkHex);

    setPhase('waiting');
  }

  // --- Commit-Reveal Flow ---
  async function handleCommitReveal() {
    const internalPubkey = deriveInternalPubkey();
    const fundingUtxos = buildFundingUtxos();
    const btcNetwork = bitcoinNetworkForAddress(wallet.taprootAddress);

    const hasInscription = !!(inscriptionFile || delegateInscriptionId);
    const hasCommitVanity = commitVanityConfig.prefix.length > 0 || commitVanityConfig.suffix.length > 0;

    const commitParamsBase = {
      runeName: etching.runeName,
      inscriptionFile: hasInscription ? inscriptionFile : null,
      delegateId: hasInscription ? delegateInscriptionId : null,
      parentInscription: hasInscription ? parentInscription : null,
      fundingUtxos,
      feeRate: selectedFeeRate,
      // When user picked a separate reveal budget, fund commit.vout[0] for it.
      // Falls back to selectedFeeRate inside commit.ts when undefined.
      revealFeeRate: selectedRevealFeeRate ?? undefined,
      changeAddress: getChangeAddress(),
      internalPubkey,
      network: btcNetwork,
    };

    // No commit vanity → build + sign directly.
    if (!hasCommitVanity) {
      const result = buildCommitTx(commitParamsBase);
      await signAndBroadcastCommit(result, internalPubkey);
      return;
    }

    // Commit vanity → grind nLockTime first, then rebuild with the winning value
    // and sign. Same pattern as quick-mode vanity (handleQuickEtch).
    setGrinding(true);
    broadcastingRef.current = false;
    setLoading(false);

    const template = serializeForTxid(buildCommitTx({ ...commitParamsBase, locktime: 0 }).psbt);

    const grinder = new VanityGrinder();
    grinderRef.current = grinder;

    await new Promise<void>((resolve, reject) => {
      grinder.start({
        txTemplate: template,
        nonceOffset: template.length - 4, // nLockTime = last 4 bytes
        nonceLength: 4,
        config: commitVanityConfig,
        onProgress: (progress) => setCommitVanityProgress(progress),
        onFound: async (nonce) => {
          grinderRef.current = null;
          setGrinding(false);
          setLoading(true);
          broadcastingRef.current = true;

          try {
            const dv = new DataView(nonce.buffer, nonce.byteOffset, nonce.byteLength);
            const foundLocktime = dv.getUint32(0, true);
            setCommitVanityLocktime(foundLocktime);

            const finalResult = buildCommitTx({ ...commitParamsBase, locktime: foundLocktime });
            await signAndBroadcastCommit(finalResult, internalPubkey);
            resolve();
          } catch (err) {
            if (err instanceof DustConfirmNeeded) { resolve(); return; }
            reject(err);
          }
        },
      });
    });
  }

  // --- Main handler ---
  async function handleClick() {
    if (broadcastingRef.current || grinding) return;

    // H2: Prevent re-broadcast if commit already exists
    if (commitState) {
      setError('Commit already broadcast. Proceed to the waiting step.');
      return;
    }

    if (!etching.runeName) { setError('Rune name is empty.'); return; }
    if (selected.length === 0) { setError('No UTXOs selected.'); return; }

    broadcastingRef.current = true;
    setLoading(true);
    setError(null);

    try {
      // C1: Re-check name availability right before broadcast. #10 — distinguish
      // 'taken' from 'unknown'-due-to-lag so we never falsely report taken when
      // the truth is uncertain, and never silently broadcast on a stale 404.
      const nameStatus = await getRuneNameStatus(etching.runeName);
      if (nameStatus.state === 'taken') {
        throw new Error(
          `Rune name "${etching.runeName}" has been taken. Do not broadcast.`
        );
      }
      if (nameStatus.state === 'unknown') {
        throw new Error(
          `Indexer is ${nameStatus.behind} blocks behind chain tip (ord at ${nameStatus.indexerHeight}, tip at ${nameStatus.chainHeight}). Cannot confirm "${etching.runeName}" is still unused — wait for the indexer to catch up before broadcasting.`
        );
      }

      if (isQuick) {
        await handleQuickEtch();
      } else {
        await handleCommitReveal();
      }
    } catch (err) {
      if (!(err instanceof DustConfirmNeeded)) {
        setError(err instanceof Error ? err.message : 'An unknown error occurred.');
      }
    } finally {
      broadcastingRef.current = false;
      setLoading(false);
    }
  }

  function handleCancelGrind() {
    grinderRef.current?.stop();
    grinderRef.current = null;
    setGrinding(false);
    // Reset whichever progress source was driving this grind.
    if (isQuick) {
      setVanityProgress({ attempts: 0, speed: 0, bestMatch: '', found: false, nonce: null });
    } else {
      setCommitVanityProgress({ attempts: 0, speed: 0, bestMatch: '', found: false, nonce: null });
    }
  }

  const buttonLabel = grinding
    ? 'Grinding...'
    : loading
      ? 'Broadcasting...'
      : isQuick
        ? 'Quick Etch'
        : 'Commit & Sign';

  return (
    <div className="flex flex-col gap-3 w-full">
      {/* Dust change confirmation dialog */}
      {dustConfirm !== null && (
        <div className="rounded-lg border border-yellow-500/30 bg-yellow-500/10 px-4 py-3 flex flex-col gap-2">
          <p className="text-sm text-yellow-400">
            {dustConfirm} sats of change is below dust limit and will be donated to miners.
          </p>
          <div className="flex gap-2">
            <button
              onClick={() => setDustConfirm(null)}
              className="rounded-lg border border-gray-600 px-4 py-1.5 text-xs text-gray-300 hover:border-gray-400 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={() => handleClick()}
              className="rounded-lg bg-yellow-600 hover:bg-yellow-500 px-4 py-1.5 text-xs font-semibold text-white transition-colors"
            >
              Accept & Continue
            </button>
          </div>
        </div>
      )}

      {/* Vanity grinding status — sourced from quick-vanity (isQuick mode) or
          commit-vanity (commit-reveal mode), whichever is active. */}
      {grinding && (() => {
        const activeConfig = isQuick ? vanityConfig : commitVanityConfig;
        const activeProgress = isQuick ? vanityProgress : commitVanityProgress;
        const label = isQuick ? 'Grinding vanity TXID...' : 'Grinding commit TXID...';
        return (
        <div className="flex flex-col gap-3 rounded-lg border border-gray-800 bg-gray-900 p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="inline-block w-2 h-2 rounded-full bg-orange-500 animate-pulse" />
              <p className="text-sm font-medium text-gray-300">{label}</p>
            </div>
            <button
              onClick={handleCancelGrind}
              className="text-xs text-gray-500 hover:text-red-400 transition-colors"
            >
              Cancel
            </button>
          </div>
          <div className="flex flex-col gap-1.5 text-xs font-mono">
            <div className="flex justify-between">
              <span className="text-gray-500">Target</span>
              <span className="text-orange-400">
                {activeConfig.prefix && `prefix: ${activeConfig.prefix}`}
                {activeConfig.prefix && activeConfig.suffix && ' | '}
                {activeConfig.suffix && `suffix: ${activeConfig.suffix}`}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-500">Attempts</span>
              <span className="text-gray-300">{activeProgress.attempts.toLocaleString()}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-500">Speed</span>
              <span className="text-gray-300">
                {activeProgress.speed > 0 ? `${activeProgress.speed.toLocaleString()} h/s` : '--'}
              </span>
            </div>
          </div>
        </div>
        );
      })()}

      {/* Error display */}
      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400">
          {error}
        </div>
      )}

      {/* Main button */}
      <button
        onClick={handleClick}
        disabled={!canBuild || loading || grinding}
        className="w-full rounded-lg bg-orange-500 hover:bg-orange-400 active:bg-orange-600 disabled:opacity-60 disabled:cursor-not-allowed px-6 py-3 font-semibold text-white transition-colors"
      >
        {(loading || grinding) && (
          <span className="inline-block w-4 h-4 mr-2 border-2 border-white/30 border-t-white rounded-full animate-spin align-middle" />
        )}
        {buttonLabel}
      </button>
    </div>
  );
}

/** Sentinel error used to interrupt flow when dust confirmation is needed. */
class DustConfirmNeeded extends Error {
  constructor() { super('Dust confirmation needed'); }
}

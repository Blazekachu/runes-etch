'use client';

import { useRef, useState, useEffect } from 'react';
import * as bitcoin from 'bitcoinjs-lib';
import { useBuilderStore } from '@/store/builderStore';
import { buildCommitTx } from '@/lib/runes/commit';
import { buildQuickEtchTx } from '@/lib/runes/quickEtch';
import { serializeForTxid } from '@/lib/runes/reveal';
import { signPsbt } from '@/lib/wallet/xverse';
import { broadcastTx, bitcoinNetworkForAddress, getCurrentBlockHeight } from '@/lib/api/mempool';
import { checkRuneNameAvailable } from '@/lib/api/ordinals';
import { VanityGrinder } from '@/lib/vanity/grinder';

export default function BuildButton() {
  const etching = useBuilderStore((s) => s.etching);
  const wallet = useBuilderStore((s) => s.wallet);
  const inscriptionFile = useBuilderStore((s) => s.inscriptionFile);
  const delegateInscriptionId = useBuilderStore((s) => s.delegateInscriptionId);
  const parentInscription = useBuilderStore((s) => s.parentInscription);
  const selectedFeeRate = useBuilderStore((s) => s.selectedFeeRate);
  const vanityConfig = useBuilderStore((s) => s.vanityConfig);
  const vanityProgress = useBuilderStore((s) => s.vanityProgress);
  const setVanityProgress = useBuilderStore((s) => s.setVanityProgress);
  const detectedMode = useBuilderStore((s) => s.detectedMode);
  const phase = useBuilderStore((s) => s.phase);
  const setPhase = useBuilderStore((s) => s.setPhase);
  const setCommitState = useBuilderStore((s) => s.setCommitState);
  const setCachedTapscript = useBuilderStore((s) => s.setCachedTapscript);
  const setQuickTxid = useBuilderStore((s) => s.setQuickTxid);
  const orderedFundingUtxos = useBuilderStore((s) => s.orderedFundingUtxos);
  const getChangeAddress = useBuilderStore((s) => s.changeAddress);
  const commitState = useBuilderStore((s) => s.commitState);

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

  const canBuild =
    wallet.connected &&
    !!etching.runeName &&
    selected.length > 0 &&
    selectedFeeRate > 0;

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
    return selected.map((u) => ({
      ...u,
      address: u.source === 'payment' ? wallet.paymentAddress : wallet.taprootAddress,
    }));
  }

  async function signAndBroadcastPsbt(psbt: bitcoin.Psbt, fee: number): Promise<string> {
    // Dust change check
    const totalIn = selected.reduce((acc, u) => acc + BigInt(u.value), 0n);
    const changeValue = totalIn - BigInt(fee);
    if (changeValue > 0n && changeValue < 546n && dustConfirm !== Number(changeValue)) {
      setDustConfirm(Number(changeValue));
      setLoading(false);
      // Throw to interrupt; user must accept dust then re-click
      throw new DustConfirmNeeded();
    }

    const psbtBase64 = psbt.toBase64();
    const inputsToSign = selected.map((u, i) => ({
      index: i,
      address: u.source === 'payment' ? wallet.paymentAddress : wallet.taprootAddress,
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
    });

    const txid = await signAndBroadcastPsbt(result.psbt, result.fee);
    setQuickTxid(txid);
    setPhase('complete');
  }

  // --- Commit-Reveal Flow ---
  async function handleCommitReveal() {
    const internalPubkey = deriveInternalPubkey();
    const fundingUtxos = buildFundingUtxos();
    const btcNetwork = bitcoinNetworkForAddress(wallet.taprootAddress);

    const hasInscription = !!(inscriptionFile || delegateInscriptionId);

    const result = buildCommitTx({
      runeName: etching.runeName,
      inscriptionFile: hasInscription ? inscriptionFile : null,
      delegateId: hasInscription ? delegateInscriptionId : null,
      parentInscription: hasInscription ? parentInscription : null,
      fundingUtxos,
      feeRate: selectedFeeRate,
      changeAddress: getChangeAddress(),
      internalPubkey,
      network: btcNetwork,
    });

    // Dust change warning
    if (result.dustChange > 0 && dustConfirm !== result.dustChange) {
      setDustConfirm(result.dustChange);
      setLoading(false);
      throw new DustConfirmNeeded();
    }

    const psbtBase64 = result.psbt.toBase64();
    const inputsToSign = selected.map((u, i) => ({
      index: i,
      address: u.source === 'payment' ? wallet.paymentAddress : wallet.taprootAddress,
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

    // Cache tapscript data so reveal step works after page refresh
    const tapHex = Buffer.from(result.tapscript).toString('hex');
    const cbHex = Buffer.from(result.controlBlock).toString('hex');
    const pkHex = internalPubkey.toString('hex');
    setCachedTapscript(tapHex, cbHex, pkHex);

    setPhase('waiting');
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
      // C1: Re-check name availability right before broadcast
      const nameAvailable = await checkRuneNameAvailable(etching.runeName);
      if (!nameAvailable) {
        throw new Error(
          `Rune name "${etching.runeName}" has been taken. Do not broadcast.`
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
    setVanityProgress({ attempts: 0, speed: 0, bestMatch: '', found: false, nonce: null });
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

      {/* Vanity grinding status */}
      {grinding && (
        <div className="flex flex-col gap-3 rounded-lg border border-gray-800 bg-gray-900 p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="inline-block w-2 h-2 rounded-full bg-orange-500 animate-pulse" />
              <p className="text-sm font-medium text-gray-300">Grinding vanity TXID...</p>
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
                {vanityConfig.prefix && `prefix: ${vanityConfig.prefix}`}
                {vanityConfig.prefix && vanityConfig.suffix && ' | '}
                {vanityConfig.suffix && `suffix: ${vanityConfig.suffix}`}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-500">Attempts</span>
              <span className="text-gray-300">{vanityProgress.attempts.toLocaleString()}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-500">Speed</span>
              <span className="text-gray-300">
                {vanityProgress.speed > 0 ? `${vanityProgress.speed.toLocaleString()} h/s` : '--'}
              </span>
            </div>
          </div>
        </div>
      )}

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

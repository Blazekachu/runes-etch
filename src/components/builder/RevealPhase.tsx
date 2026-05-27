'use client';

import { useEffect, useState, useRef } from 'react';
import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';
import { useBuilderStore } from '@/store/builderStore';
import { buildRevealTx, serializeForTxid, computeTxid } from '@/lib/runes/reveal';
import { buildTapscript, buildBareTapscript } from '@/lib/runes/inscription';
import { runeNameToCommitmentBytes } from '@/lib/runes/names';
import { signPsbt, connectWallet, getActiveProvider } from '@/lib/wallet/xverse';
import { broadcastTx, fetchFeeRates, getTxConfirmations, fetchUtxos, setMempoolNetwork, bitcoinNetworkForAddress } from '@/lib/api/mempool';
import { getRuneNameStatus, setOrdinalsTestnet, resolveParentForReveal } from '@/lib/api/ordinals';
import type { FeeRates } from '@/types';

bitcoin.initEccLib(ecc);

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export default function RevealPhase(_props?: Record<string, unknown>) {
  const etching = useBuilderStore((s) => s.etching);
  const wallet = useBuilderStore((s) => s.wallet);
  const commitState = useBuilderStore((s) => s.commitState);
  const parentInscription = useBuilderStore((s) => s.parentInscription);
  const inscriptionFile = useBuilderStore((s) => s.inscriptionFile);
  const delegateInscriptionId = useBuilderStore((s) => s.delegateInscriptionId);
  const hasInscription = !!inscriptionFile || !!delegateInscriptionId;
  const vanityLocktime = useBuilderStore((s) => s.vanityLocktime);
  const selectedFeeRate = useBuilderStore((s) => s.selectedFeeRate);
  const setSelectedFeeRate = useBuilderStore((s) => s.setSelectedFeeRate);
  const setWallet = useBuilderStore((s) => s.setWallet);
  const setRevealTxid = useBuilderStore((s) => s.setRevealTxid);
  const setPhase = useBuilderStore((s) => s.setPhase);

  const [reconnecting, setReconnecting] = useState(false);
  const broadcastingRef = useRef(false);

  const [feeRates, setFeeRates] = useState<FeeRates | null>(null);
  const [feeMode, setFeeMode] = useState<'economy' | 'normal' | 'fast' | 'custom'>('normal');
  const [customRate, setCustomRate] = useState('');
  const [loadingFees, setLoadingFees] = useState(false);
  const [feeError, setFeeError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [highFeeConfirm, setHighFeeConfirm] = useState(false);

  // If vanity locktime was found, the fee rate is locked — changing it would
  // invalidate the grinded TXID. Only allow fee rate changes when no vanity.
  const hasVanityLocktime = vanityLocktime !== null && vanityLocktime > 0;

  useEffect(() => {
    if (!hasVanityLocktime) loadFeeRates();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (hasVanityLocktime) return; // don't override fee rate — locked for vanity
    if (!feeRates) return;
    if (feeMode === 'economy') setSelectedFeeRate(feeRates.economyFee);
    else if (feeMode === 'normal') setSelectedFeeRate(feeRates.halfHourFee);
    else if (feeMode === 'fast') setSelectedFeeRate(feeRates.fastestFee);
    else if (feeMode === 'custom') {
      const v = parseInt(customRate, 10);
      if (!isNaN(v) && v > 0) setSelectedFeeRate(v);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [feeMode, feeRates, customRate]);

  async function loadFeeRates() {
    setLoadingFees(true);
    setFeeError(null);
    try {
      const rates = await fetchFeeRates();
      setFeeRates(rates);
    } catch (err) {
      setFeeError(err instanceof Error ? err.message : 'Failed to fetch fee rates');
    } finally {
      setLoadingFees(false);
    }
  }

  const MIN_FEE_RATE = 2;
  const MAX_FEE_RATE = 2000;
  const HIGH_FEE_WARNING = 500;

  function handleCustomRate(val: string) {
    setCustomRate(val);
    setFeeMode('custom');
    const v = parseInt(val, 10);
    if (!isNaN(v) && v >= MIN_FEE_RATE) setSelectedFeeRate(Math.min(v, MAX_FEE_RATE));
  }

  async function handleReconnect() {
    setReconnecting(true);
    try {
      const w = await connectWallet(getActiveProvider());
      await setMempoolNetwork(w.taprootAddress);
      setOrdinalsTestnet(w.taprootAddress);
      setWallet(w);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to reconnect wallet');
    } finally {
      setReconnecting(false);
    }
  }

  const needsReconnect = !wallet.publicKey;

  async function handleReveal() {
    // Double-broadcast guard (ref-based)
    if (broadcastingRef.current) return;
    if (!etching.runeName) { setError('Rune name is empty.'); return; }
    if (!commitState) {
      setError('No commit state found. Please complete the commit step first.');
      return;
    }

    if (selectedFeeRate > HIGH_FEE_WARNING && !highFeeConfirm) {
      setHighFeeConfirm(true);
      return;
    }
    setHighFeeConfirm(false);

    broadcastingRef.current = true;
    setLoading(true);
    setError(null);

    try {
      // C1: Re-check name availability before reveal broadcast. #10 — block on
      // 'unknown' (indexer lag) with distinct message so user knows to wait
      // rather than thinking the name was stolen.
      const nameStatus = await getRuneNameStatus(etching.runeName);
      if (nameStatus.state === 'taken') {
        throw new Error(`Rune name "${etching.runeName}" has been taken. Broadcasting would produce a cenotaph. Your commit funds can be recovered via the tapscript.`);
      }
      if (nameStatus.state === 'unknown') {
        throw new Error(`Indexer is ${nameStatus.behind} blocks behind chain tip (ord at ${nameStatus.indexerHeight}, tip at ${nameStatus.chainHeight}). Cannot confirm "${etching.runeName}" is still unused — wait for the indexer to catch up before broadcasting the reveal.`);
      }

      // H-5: Re-verify commit TX has 6 confirmations before building reveal
      const confirmations = await getTxConfirmations(commitState.txid);
      if (confirmations < 6) {
        throw new Error(`Commit TX only has ${confirmations}/6 confirmations. Please wait.`);
      }

      // Parent re-resolution: re-resolve parent inscription UTXO — it may have moved since commit
      // Skip on testnet (ordinals.com is mainnet-only)
      const isTestnet = wallet.taprootAddress.startsWith('tb1');
      let resolvedParent = parentInscription;
      if (hasInscription && parentInscription && !isTestnet) {
        const parentResult = await resolveParentForReveal(
          parentInscription.inscriptionId,
          wallet.taprootAddress
        );
        if (parentResult.status === 'moved') {
          throw new Error(`Parent not owned by signer. Current owner: ${parentResult.currentAddress}. The parent must be in your wallet to sign the reveal.`);
        }
        if (parentResult.status === 'not-found') {
          throw new Error(`Parent inscription not found: ${parentResult.error}`);
        }
        resolvedParent = parentResult.parent;
      }

      // Cached tapscript: Use cached internal pubkey if available (matches what grinder used),
      // otherwise derive from wallet public key
      const { cachedTapscriptHex, cachedControlBlockHex, cachedInternalPubkeyHex } = useBuilderStore.getState();
      let internalPubkey: Buffer;
      if (cachedInternalPubkeyHex) {
        internalPubkey = Buffer.from(cachedInternalPubkeyHex, 'hex');
      } else {
        if (!/^[0-9a-f]+$/i.test(wallet.publicKey)) {
          throw new Error('Invalid public key: not valid hex');
        }
        const fullPubkey = Buffer.from(wallet.publicKey, 'hex');
        if (fullPubkey.length !== 33 && fullPubkey.length !== 32) {
          throw new Error(`Invalid public key length: ${fullPubkey.length} bytes (expected 32 or 33)`);
        }
        internalPubkey = fullPubkey.length === 33 ? fullPubkey.slice(1) : fullPubkey;
      }

      // Build or restore tapscript + control block.
      // Use cached hex from commit/bundle — this guarantees the same data the grinder used.
      const runeCommitment = runeNameToCommitmentBytes(etching.runeName);
      const currentInscriptionFile = useBuilderStore.getState().inscriptionFile;

      let tapscript: Uint8Array;
      let controlBlock: Buffer;
      const btcNetwork = bitcoinNetworkForAddress(wallet.taprootAddress);

      if (cachedTapscriptHex && cachedControlBlockHex) {
        // Use cached data from bundle — guaranteed to match the commit TX
        tapscript = Buffer.from(cachedTapscriptHex, 'hex');
        controlBlock = Buffer.from(cachedControlBlockHex, 'hex');
      } else if (hasInscription && currentInscriptionFile) {
        tapscript = buildTapscript(internalPubkey, {
          contentType: currentInscriptionFile.contentType,
          body: currentInscriptionFile.body,
          parentId: resolvedParent?.inscriptionId ?? null,
          delegateId: delegateInscriptionId,
          runeCommitment,
        });
        const scriptTree = { output: Buffer.from(tapscript) };
        const redeemPayment = bitcoin.payments.p2tr({
          internalPubkey, scriptTree,
          redeem: { output: Buffer.from(tapscript), redeemVersion: 0xc0 },
          network: btcNetwork,
        });
        const cbWitness = redeemPayment.witness;
        controlBlock = cbWitness && cbWitness.length > 0
          ? Buffer.from(cbWitness[cbWitness.length - 1])
          : Buffer.alloc(0);
      } else if (hasInscription && delegateInscriptionId) {
        tapscript = buildTapscript(internalPubkey, {
          contentType: '',
          body: new Uint8Array(0),
          parentId: resolvedParent?.inscriptionId ?? null,
          delegateId: delegateInscriptionId,
          runeCommitment,
        });
        const scriptTree = { output: Buffer.from(tapscript) };
        const redeemPayment = bitcoin.payments.p2tr({
          internalPubkey, scriptTree,
          redeem: { output: Buffer.from(tapscript), redeemVersion: 0xc0 },
          network: btcNetwork,
        });
        const cbWitness = redeemPayment.witness;
        controlBlock = cbWitness && cbWitness.length > 0
          ? Buffer.from(cbWitness[cbWitness.length - 1])
          : Buffer.alloc(0);
      } else if (!hasInscription) {
        tapscript = buildBareTapscript(internalPubkey, runeCommitment);
        const scriptTree = { output: Buffer.from(tapscript) };
        const redeemPayment = bitcoin.payments.p2tr({
          internalPubkey, scriptTree,
          redeem: { output: Buffer.from(tapscript), redeemVersion: 0xc0 },
          network: btcNetwork,
        });
        const cbWitness = redeemPayment.witness;
        controlBlock = cbWitness && cbWitness.length > 0
          ? Buffer.from(cbWitness[cbWitness.length - 1])
          : Buffer.alloc(0);
      } else {
        throw new Error('No inscription file, delegate, or cached tapscript found. Upload the bundle to resume.');
      }

      const scriptTree = { output: Buffer.from(tapscript) };

      // H3: Verify commit UTXO still exists before building reveal
      const { address: commitAddr } = bitcoin.payments.p2tr({ internalPubkey, scriptTree, network: btcNetwork });
      if (commitAddr) {
        const utxos = await fetchUtxos(commitAddr);
        const found = utxos.some((u) => u.txid === commitState.txid && u.vout === commitState.commitOutputIndex);
        if (!found) {
          throw new Error('Commit UTXO has been spent or not found. The locked funds may be gone.');
        }
      }

      const { psbt } = buildRevealTx({
        etching,
        commitState,
        tapscript,
        controlBlock,
        internalPubkey,
        hasInscription,
        parentInscription: hasInscription ? resolvedParent : null,
        additionalFundingUtxos: [],
        feeRate: selectedFeeRate,
        receiverAddress: wallet.taprootAddress,
        // #12: prefer payment (segwit) over taproot for change. The old
        // `commitState.changeAddress || wallet.taprootAddress` chain skipped
        // segwit entirely when commitState.changeAddress was blank (bundle resume).
        changeAddress: commitState.changeAddress || wallet.paymentAddress || wallet.taprootAddress,
        vanityNonce: new Uint8Array(0),
        locktime: vanityLocktime ?? 0,
        network: bitcoinNetworkForAddress(wallet.taprootAddress),
      });

      // Vanity TXID verification: if vanity locktime, log expected TXID
      if (vanityLocktime && vanityLocktime > 0) {
        const expectedBytes = serializeForTxid(psbt);
        const expectedTxid = computeTxid(expectedBytes);
        console.log('[Reveal] Expected vanity TXID:', expectedTxid, 'locktime:', vanityLocktime);
      }

      // All inputs must be signed. Commit input (index 0) uses script path;
      // remaining inputs (parent, funding) use key path — all via taprootAddress.
      const inputCount = psbt.inputCount;
      const inputsToSign = Array.from({ length: inputCount }, (_, i) => ({
        index: i,
        address: wallet.taprootAddress,
      }));

      const signedBase64 = await signPsbt(psbt.toBase64(), inputsToSign);

      const signedPsbt = bitcoin.Psbt.fromBase64(signedBase64);
      signedPsbt.finalizeAllInputs();
      const finalTx = signedPsbt.extractTransaction();
      const txHex = finalTx.toHex();
      const txid = finalTx.getId();

      await broadcastTx(txHex);
      setRevealTxid(txid);
      setPhase('complete');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An unknown error occurred.');
    } finally {
      broadcastingRef.current = false;
      setLoading(false);
    }
  }

  const feeButtonClass = (mode: typeof feeMode) =>
    `flex-1 rounded-lg border px-3 py-2.5 text-sm font-semibold transition-colors ${
      feeMode === mode
        ? 'border-orange-500 bg-orange-500/10 text-orange-400'
        : 'border-gray-700 bg-gray-900 text-gray-400 hover:border-gray-600 hover:text-white'
    }`;

  return (
    <div className="flex flex-col gap-8 py-8 max-w-xl mx-auto w-full">
      <div>
        <h2 className="text-2xl font-bold text-white mb-1">Reveal & Complete</h2>
        <p className="text-gray-400 text-sm">
          Choose a fee rate and broadcast the reveal transaction to complete the etch.
        </p>
      </div>

      {/* Commit reference */}
      {commitState && (
        <div className="rounded-lg border border-gray-800 bg-gray-900 px-4 py-3">
          <p className="text-xs text-gray-500 mb-1">Commit TXID</p>
          <p className="font-mono text-xs text-white break-all">{commitState.txid}</p>
        </div>
      )}

      {/* Vanity locktime notice */}
      {hasVanityLocktime && (
        <div className="rounded-lg border border-orange-500/30 bg-orange-500/10 px-4 py-3 text-sm text-orange-400">
          Vanity TXID locked at {selectedFeeRate} sat/vB (nLockTime: {vanityLocktime}). Fee rate cannot be changed without invalidating the vanity match.
        </div>
      )}

      {/* Fee rates */}
      {!hasVanityLocktime && (
      <div className="flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <p className="text-sm font-medium text-gray-300">Fee Rate</p>
          <button
            onClick={loadFeeRates}
            disabled={loadingFees}
            className="text-xs text-gray-500 hover:text-gray-300 disabled:opacity-40 transition-colors"
          >
            {loadingFees ? 'Loading...' : 'Refresh'}
          </button>
        </div>

        {feeError && (
          <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-xs text-red-400">
            {feeError}
          </div>
        )}

        <div className="flex gap-2">
          <button className={feeButtonClass('economy')} onClick={() => setFeeMode('economy')}>
            <div>Economy</div>
            {feeRates && <div className="text-xs font-mono opacity-70 mt-0.5">{feeRates.economyFee} sat/vB</div>}
          </button>
          <button className={feeButtonClass('normal')} onClick={() => setFeeMode('normal')}>
            <div>Normal</div>
            {feeRates && <div className="text-xs font-mono opacity-70 mt-0.5">{feeRates.halfHourFee} sat/vB</div>}
          </button>
          <button className={feeButtonClass('fast')} onClick={() => setFeeMode('fast')}>
            <div>Fast</div>
            {feeRates && <div className="text-xs font-mono opacity-70 mt-0.5">{feeRates.fastestFee} sat/vB</div>}
          </button>
        </div>

        {/* Custom input */}
        <div className="flex items-center gap-3">
          <input
            type="number"
            min={1}
            value={customRate}
            onChange={(e) => handleCustomRate(e.target.value)}
            onFocus={() => setFeeMode('custom')}
            placeholder="Custom sat/vB"
            className={`flex-1 rounded-lg border px-4 py-2.5 font-mono text-sm text-white placeholder-gray-600 bg-gray-900 focus:outline-none transition-colors ${
              feeMode === 'custom' ? 'border-orange-500' : 'border-gray-700'
            }`}
          />
          <span className="text-sm text-gray-500 shrink-0">sat/vB</span>
        </div>

        {/* Selected rate summary */}
        <div className="flex items-center justify-between rounded-lg border border-gray-800 bg-gray-900 px-4 py-3">
          <span className="text-sm text-gray-400">Selected rate</span>
          <span className="font-mono text-sm text-white font-semibold">{selectedFeeRate} sat/vB</span>
        </div>
      </div>
      )}

      {highFeeConfirm && (
        <div className="rounded-lg border border-yellow-500/30 bg-yellow-500/10 px-4 py-3 flex flex-col gap-2">
          <p className="text-sm text-yellow-400">
            Fee rate is {selectedFeeRate} sat/vB which is very high. Are you sure?
          </p>
          <div className="flex gap-2">
            <button
              onClick={() => setHighFeeConfirm(false)}
              className="rounded-lg border border-gray-600 px-4 py-1.5 text-xs text-gray-300 hover:border-gray-400 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleReveal}
              className="rounded-lg bg-yellow-600 hover:bg-yellow-500 px-4 py-1.5 text-xs font-semibold text-white transition-colors"
            >
              Yes, Broadcast
            </button>
          </div>
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400">
          {error}
        </div>
      )}

      {needsReconnect ? (
        <div className="flex flex-col gap-3">
          <div className="rounded-lg border border-yellow-500/30 bg-yellow-500/10 px-4 py-3 text-sm text-yellow-400">
            Wallet not connected. Please reconnect to sign the reveal transaction.
          </div>
          <button
            onClick={handleReconnect}
            disabled={reconnecting}
            className="w-full rounded-lg bg-orange-500 hover:bg-orange-400 active:bg-orange-600 disabled:opacity-60 disabled:cursor-not-allowed px-6 py-2.5 font-semibold text-white transition-colors"
          >
            {reconnecting ? 'Connecting...' : 'Reconnect Wallet'}
          </button>
        </div>
      ) : (
        <button
          onClick={handleReveal}
          disabled={loading}
          className="w-full rounded-lg bg-orange-500 hover:bg-orange-400 active:bg-orange-600 disabled:opacity-60 disabled:cursor-not-allowed px-6 py-2.5 font-semibold text-white transition-colors"
        >
          {loading ? 'Broadcasting reveal...' : 'Sign & Broadcast Reveal'}
        </button>
      )}
    </div>
  );
}

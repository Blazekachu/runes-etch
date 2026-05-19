'use client';

import { useState, useRef, useEffect } from 'react';
import * as bitcoin from 'bitcoinjs-lib';
import { useEtchStore } from '@/store/etchStore';
import { buildQuickEtchTx } from '@/lib/runes/quickEtch';
import { serializeForTxid } from '@/lib/runes/reveal';
import { signPsbt } from '@/lib/wallet/xverse';
import { broadcastTx, getCurrentBlockHeight, bitcoinNetworkForAddress } from '@/lib/api/mempool';
import { checkRuneNameAvailable } from '@/lib/api/ordinals';
import { VanityGrinder } from '@/lib/vanity/grinder';

function mempoolTxUrl(address: string): string {
  if (address.startsWith('tb1') || address.startsWith('2') || address.startsWith('m') || address.startsWith('n')) {
    return 'https://mempool.space/testnet4/tx';
  }
  return 'https://mempool.space/tx';
}

export default function QuickEtchReview({ onBack }: { onNext?: () => void; onBack?: () => void }) {
  const etching = useEtchStore((s) => s.etching);
  const wallet = useEtchStore((s) => s.wallet);
  const selectedFeeRate = useEtchStore((s) => s.selectedFeeRate);
  const vanityConfig = useEtchStore((s) => s.vanityConfig);
  const vanityProgress = useEtchStore((s) => s.vanityProgress);
  const setVanityProgress = useEtchStore((s) => s.setVanityProgress);
  const selectedUtxos = useEtchStore((s) => s.selectedUtxos);
  const getChangeAddress = useEtchStore((s) => s.changeAddress);
  const reset = useEtchStore((s) => s.reset);

  const [loading, setLoading] = useState(false);
  const [grinding, setGrinding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [txid, setTxid] = useState<string | null>(null);
  const [dustConfirm, setDustConfirm] = useState<number | null>(null);
  const broadcastingRef = useRef(false);
  const grinderRef = useRef<VanityGrinder | null>(null);

  const selected = selectedUtxos();
  const totalFunding = selected.reduce((acc, u) => acc + u.value, 0);

  const hasVanity = vanityConfig.prefix.length > 0 || vanityConfig.suffix.length > 0;
  const vanityDisplay = hasVanity
    ? [vanityConfig.prefix && `prefix: ${vanityConfig.prefix}`, vanityConfig.suffix && `suffix: ${vanityConfig.suffix}`]
        .filter(Boolean)
        .join(', ')
    : 'None';

  // Cleanup grinder on unmount
  useEffect(() => {
    return () => { grinderRef.current?.stop(); };
  }, []);

  function buildTxParams() {
    if (!/^[0-9a-f]+$/i.test(wallet.publicKey)) {
      throw new Error('Invalid public key: not valid hex');
    }
    const fullPubkey = Buffer.from(wallet.publicKey, 'hex');
    if (fullPubkey.length !== 33 && fullPubkey.length !== 32) {
      throw new Error(`Invalid public key length: ${fullPubkey.length} bytes (expected 32 or 33)`);
    }
    const internalPubkey = fullPubkey.length === 33 ? fullPubkey.slice(1) : fullPubkey;
    const fundingUtxos = selected.map((u) => ({
      ...u,
      address: u.source === 'payment' ? wallet.paymentAddress : wallet.taprootAddress,
    }));
    return { internalPubkey, fundingUtxos };
  }

  async function handleSignAndBroadcast() {
    if (broadcastingRef.current || grinding) return;
    if (!etching.runeName) { setError('Rune name is empty.'); return; }
    if (selected.length === 0) {
      setError('No UTXOs selected.');
      return;
    }

    broadcastingRef.current = true;
    setLoading(true);
    setError(null);

    try {
      // C1: Re-check name availability right before broadcast
      const nameAvailable = await checkRuneNameAvailable(etching.runeName);
      if (!nameAvailable) {
        throw new Error(`Rune name "${etching.runeName}" has been taken by someone else.`);
      }

      const { internalPubkey, fundingUtxos } = buildTxParams();
      const currentBlockHeight = await getCurrentBlockHeight();
      const btcNetwork = bitcoinNetworkForAddress(wallet.taprootAddress);
      const isTestnet = wallet.taprootAddress.startsWith('tb1');

      // If vanity is configured, grind for a matching nLockTime before signing
      if (hasVanity) {
        setGrinding(true);
        broadcastingRef.current = false;
        setLoading(false);

        // Build a template TX with locktime=0 to get the serialization
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

              await signAndBroadcastPsbt(finalResult.psbt, finalResult.fee);
            } catch (err) {
              setError(err instanceof Error ? err.message : 'An unknown error occurred.');
            } finally {
              broadcastingRef.current = false;
              setLoading(false);
            }
          },
        });
        return;
      }

      // No vanity — build and broadcast directly
      const result = buildQuickEtchTx({
        etching, fundingUtxos, feeRate: selectedFeeRate,
        receiverAddress: wallet.taprootAddress, changeAddress: getChangeAddress(),
        internalPubkey, vanityNonce: new Uint8Array(0), currentBlockHeight, isTestnet,
        network: btcNetwork,
      });

      await signAndBroadcastPsbt(result.psbt, result.fee);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An unknown error occurred.');
    } finally {
      broadcastingRef.current = false;
      setLoading(false);
    }
  }

  async function signAndBroadcastPsbt(psbt: bitcoin.Psbt, fee: number) {
    // C3: Warn if sub-dust change will be donated to miners
    const totalIn = selected.reduce((acc, u) => acc + BigInt(u.value), 0n);
    const changeValue = totalIn - BigInt(fee);
    if (changeValue > 0n && changeValue < 546n && dustConfirm !== Number(changeValue)) {
      setDustConfirm(Number(changeValue));
      setLoading(false);
      return;
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
    const finalTxid = finalTx.getId();

    await broadcastTx(txHex);
    setTxid(finalTxid);
  }

  function handleCancelGrind() {
    grinderRef.current?.stop();
    grinderRef.current = null;
    setGrinding(false);
    setVanityProgress({ attempts: 0, speed: 0, bestMatch: '', found: false, nonce: null });
  }

  // --- Success state ---
  if (txid) {
    return (
      <div className="flex flex-col gap-8 py-8 max-w-xl mx-auto w-full items-center text-center">
        <div className="flex items-center justify-center w-20 h-20 rounded-full bg-green-500/15 border border-green-500/30">
          <svg className="w-10 h-10 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
        </div>

        <div>
          <h2 className="text-2xl font-bold text-white mb-2">Rune Etched!</h2>
          <p className="text-gray-400 text-sm">
            Your rune has been etched in a single transaction. No commit-reveal needed.
          </p>
        </div>

        <div className="w-full rounded-lg border border-gray-800 bg-gray-900 px-6 py-4">
          <p className="text-xs text-gray-500 mb-1 uppercase tracking-wider">Rune Name</p>
          <p className="font-mono text-xl font-bold text-orange-400">{etching.runeName}</p>
        </div>

        <div className="w-full rounded-lg border border-gray-800 bg-gray-900 px-4 py-3">
          <p className="text-xs text-gray-500 mb-1">TXID</p>
          <p className="font-mono text-xs text-white break-all">{txid}</p>
        </div>

        <a
          href={`${mempoolTxUrl(wallet?.paymentAddress ?? '')}/${txid}`}
          target="_blank"
          rel="noopener noreferrer"
          className="w-full rounded-lg border border-gray-700 px-4 py-2.5 text-sm font-semibold text-gray-300 hover:border-orange-500 hover:text-orange-400 transition-colors text-center"
        >
          View on mempool.space
        </a>

        <button
          onClick={reset}
          className="w-full rounded-lg border border-gray-700 px-6 py-2.5 text-sm font-semibold text-gray-300 hover:border-gray-500 hover:text-white transition-colors"
        >
          Etch Another Rune
        </button>
      </div>
    );
  }

  // --- Review state ---
  return (
    <div className="flex flex-col gap-8 py-8 max-w-xl mx-auto w-full">
      <div>
        <h2 className="text-2xl font-bold text-white mb-1">Quick Etch — Review</h2>
        <p className="text-gray-400 text-sm">
          This will etch your rune in a single transaction. No commit-reveal protection — the rune name will be visible in the mempool.
        </p>
      </div>

      <div className="rounded-lg border border-yellow-500/30 bg-yellow-500/10 px-4 py-3 text-sm text-yellow-400">
        Quick etch has no front-running protection. Another party could see your rune name in the mempool and race to etch it first.
      </div>

      <Section title="Rune Details">
        <Row label="Rune Name" value={etching.runeName || '—'} mono />
        <Row label="Symbol" value={etching.symbol || '—'} />
        <Row label="Divisibility" value={String(etching.divisibility)} />
        <Row label="Premine" value={`${etching.premine.toLocaleString()} units`} mono />
        <Row label="Turbo" value={etching.turbo ? 'Yes' : 'No'} />
      </Section>

      {etching.terms ? (
        <Section title="Mint Terms">
          <Row label="Mint Amount" value={`${etching.terms.amount.toLocaleString()} units`} mono />
          <Row label="Mint Cap" value={`${etching.terms.cap.toLocaleString()} mints`} mono />
        </Section>
      ) : (
        <Section title="Mint Terms">
          <p className="text-sm text-gray-500 py-1">No open mint — premine only.</p>
        </Section>
      )}

      <Section title="Fees & Vanity">
        <Row label="Fee Rate" value={`${selectedFeeRate} sat/vB`} mono />
        <Row label="Vanity Config" value={vanityDisplay} mono />
      </Section>

      <Section title="Funding">
        <Row label="UTXOs Selected" value={String(selected.length)} />
        <Row label="Total Funding" value={`${totalFunding.toLocaleString()} sats`} mono />
      </Section>

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
              onClick={() => handleSignAndBroadcast()}
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
              <p className="text-sm font-medium text-gray-300">Grinding vanity TXID…</p>
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
                {vanityProgress.speed > 0 ? `${vanityProgress.speed.toLocaleString()} h/s` : '—'}
              </span>
            </div>
          </div>
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400">
          {error}
        </div>
      )}

      <div className="flex gap-3 pt-2">
        <button
          onClick={onBack}
          disabled={loading || grinding}
          className="rounded-lg border border-gray-700 px-6 py-2.5 text-sm font-semibold text-gray-300 hover:border-gray-500 hover:text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          Back
        </button>
        <button
          onClick={handleSignAndBroadcast}
          disabled={loading || grinding}
          className="flex-1 rounded-lg bg-orange-500 hover:bg-orange-400 active:bg-orange-600 disabled:opacity-60 disabled:cursor-not-allowed px-6 py-2.5 font-semibold text-white transition-colors"
        >
          {grinding ? 'Grinding…' : loading ? 'Broadcasting…' : 'Sign & Broadcast Quick Etch'}
        </button>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0 rounded-lg border border-gray-800 bg-gray-900 overflow-hidden">
      <div className="px-4 py-2.5 border-b border-gray-800 bg-gray-800/50">
        <p className="text-xs font-semibold uppercase tracking-wider text-gray-400">{title}</p>
      </div>
      <div className="flex flex-col divide-y divide-gray-800">
        {children}
      </div>
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-2.5">
      <span className="text-sm text-gray-400 shrink-0">{label}</span>
      <span className={`text-sm text-white text-right break-all ${mono ? 'font-mono' : ''}`}>{value}</span>
    </div>
  );
}

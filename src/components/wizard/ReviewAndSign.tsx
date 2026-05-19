'use client';

import { useState, useRef } from 'react';
import * as bitcoin from 'bitcoinjs-lib';
import { useEtchStore } from '@/store/etchStore';
import { buildCommitTx } from '@/lib/runes/commit';
import { signPsbt } from '@/lib/wallet/xverse';
import { broadcastTx, bitcoinNetworkForAddress } from '@/lib/api/mempool';
import { checkRuneNameAvailable } from '@/lib/api/ordinals';

export default function ReviewAndSign({ onNext, onBack }: { onNext: () => void; onBack: () => void }) {
  const etching = useEtchStore((s) => s.etching);
  const etchMode = useEtchStore((s) => s.etchMode);
  const inscriptionFile = useEtchStore((s) => s.inscriptionFile);
  const delegateInscriptionId = useEtchStore((s) => s.delegateInscriptionId);
  const parentInscription = useEtchStore((s) => s.parentInscription);
  const wallet = useEtchStore((s) => s.wallet);
  const utxos = useEtchStore((s) => s.utxos);
  const selectedFeeRate = useEtchStore((s) => s.selectedFeeRate);
  const vanityConfig = useEtchStore((s) => s.vanityConfig);
  const setCommitState = useEtchStore((s) => s.setCommitState);
  const setCachedTapscript = useEtchStore((s) => s.setCachedTapscript);
  const selectedUtxos = useEtchStore((s) => s.selectedUtxos);
  const getChangeAddress = useEtchStore((s) => s.changeAddress);

  const hasInscription = etchMode === 'full' || etchMode === 'no-parent';

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dustConfirm, setDustConfirm] = useState<number | null>(null);
  const broadcastingRef = useRef(false);

  const selected = selectedUtxos();
  const totalFunding = selected.reduce((acc, u) => acc + u.value, 0);

  const hasVanity = vanityConfig.prefix.length > 0 || vanityConfig.suffix.length > 0;
  const vanityDisplay = hasVanity
    ? [vanityConfig.prefix && `prefix: ${vanityConfig.prefix}`, vanityConfig.suffix && `suffix: ${vanityConfig.suffix}`]
        .filter(Boolean)
        .join(', ')
    : 'None';

  async function handleSignAndBroadcast() {
    // C5: Ref-based guard prevents double-click race condition
    if (broadcastingRef.current) return;
    // H2: Prevent re-broadcasting if commit already exists
    if (useEtchStore.getState().commitState) {
      setError('Commit already broadcast. Proceed to the waiting step.');
      return;
    }
    if (!etching.runeName) { setError('Rune name is empty.'); return; }
    if (hasInscription && !inscriptionFile && !delegateInscriptionId) {
      setError('No inscription file selected.');
      return;
    }
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
        throw new Error(`Rune name "${etching.runeName}" has been taken. Do not broadcast — your funds would be locked in an unspendable commit.`);
      }

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

      const result = buildCommitTx({
        runeName: etching.runeName,
        inscriptionFile: hasInscription ? inscriptionFile : null,
        delegateId: hasInscription ? delegateInscriptionId : null,
        parentInscription: hasInscription ? parentInscription : null,
        fundingUtxos,
        feeRate: selectedFeeRate,
        changeAddress: getChangeAddress(),
        internalPubkey,
        network: bitcoinNetworkForAddress(wallet.taprootAddress),
      });

      // Warn if sub-dust change will be donated to miners
      if (result.dustChange > 0 && dustConfirm !== result.dustChange) {
        setDustConfirm(result.dustChange);
        setLoading(false);
        return;
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

      onNext();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An unknown error occurred.');
    } finally {
      broadcastingRef.current = false;
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-col gap-8 py-8 max-w-xl mx-auto w-full">
      <div>
        <h2 className="text-2xl font-bold text-white mb-1">Review & Sign</h2>
        <p className="text-gray-400 text-sm">Confirm all parameters before broadcasting the commit transaction.</p>
      </div>

      {/* Rune Parameters */}
      <Section title="Rune Details">
        <Row label="Rune Name" value={etching.runeName || '—'} mono />
        <Row label="Symbol" value={etching.symbol || '—'} />
        <Row label="Divisibility" value={String(etching.divisibility)} />
        <Row label="Premine" value={`${etching.premine.toLocaleString()} units`} mono />
        <Row label="Turbo" value={etching.turbo ? 'Yes' : 'No'} />
      </Section>

      {/* Mint Terms */}
      {etching.terms ? (
        <Section title="Mint Terms">
          <Row label="Mint Amount" value={`${etching.terms.amount.toLocaleString()} units`} mono />
          <Row label="Mint Cap" value={`${etching.terms.cap.toLocaleString()} mints`} mono />
          {etching.terms.heightStart !== null && (
            <Row label="Height Start" value={String(etching.terms.heightStart)} />
          )}
          {etching.terms.heightEnd !== null && (
            <Row label="Height End" value={String(etching.terms.heightEnd)} />
          )}
          {etching.terms.offsetStart !== null && (
            <Row label="Offset Start" value={String(etching.terms.offsetStart)} />
          )}
          {etching.terms.offsetEnd !== null && (
            <Row label="Offset End" value={String(etching.terms.offsetEnd)} />
          )}
        </Section>
      ) : (
        <Section title="Mint Terms">
          <p className="text-sm text-gray-500 py-1">No open mint — premine only.</p>
        </Section>
      )}

      {/* Inscription */}
      {hasInscription ? (
        <Section title="Inscription">
          {delegateInscriptionId ? (
            <>
              <Row label="Mode" value="Delegate (no embedded content)" />
              <Row label="Delegate ID" value={delegateInscriptionId} mono />
            </>
          ) : (
            <>
              <Row label="Content Type" value={(inscriptionFile?.contentType ?? '—').slice(0, 80)} mono />
              <Row label="File Size" value={inscriptionFile ? `${inscriptionFile.body.length.toLocaleString()} bytes` : '—'} />
            </>
          )}
          <Row label="Parent ID" value={parentInscription?.inscriptionId ?? 'None'} mono />
        </Section>
      ) : (
        <Section title="Inscription">
          <p className="text-sm text-gray-500 py-1">No inscription — bare rune commitment.</p>
        </Section>
      )}

      {/* Fees & Vanity */}
      <Section title="Fees & Vanity">
        <Row label="Fee Rate" value={`${selectedFeeRate} sat/vB`} mono />
        <Row label="Vanity Config" value={vanityDisplay} mono />
      </Section>

      {/* Funding */}
      <Section title="Funding">
        <Row label="UTXOs Selected" value={String(selected.length)} />
        <Row label="Total Funding" value={`${totalFunding.toLocaleString()} sats`} mono />
      </Section>

      {/* Warning */}
      <div className="rounded-lg border border-yellow-500/30 bg-yellow-500/10 px-4 py-3 text-sm text-yellow-400">
        This will broadcast the commit transaction to the Bitcoin network. Make sure all details above are correct before proceeding.
      </div>

      {dustConfirm !== null && (
        <div className="rounded-lg border border-yellow-500/30 bg-yellow-500/10 px-4 py-3 flex flex-col gap-2">
          <p className="text-sm text-yellow-400">
            {dustConfirm} sats of change is below dust limit and will be donated to miners.
          </p>
          <div className="flex gap-2">
            <button
              onClick={() => { setDustConfirm(null); }}
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

      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400">
          {error}
        </div>
      )}

      {/* Navigation */}
      <div className="flex gap-3 pt-2">
        <button
          onClick={onBack}
          disabled={loading}
          className="rounded-lg border border-gray-700 px-6 py-2.5 text-sm font-semibold text-gray-300 hover:border-gray-500 hover:text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          Back
        </button>
        <button
          onClick={handleSignAndBroadcast}
          disabled={loading}
          className="flex-1 rounded-lg bg-orange-500 hover:bg-orange-400 active:bg-orange-600 disabled:opacity-60 disabled:cursor-not-allowed px-6 py-2.5 font-semibold text-white transition-colors"
        >
          {loading ? 'Broadcasting…' : 'Sign & Broadcast Commit'}
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

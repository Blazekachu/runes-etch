'use client';

import { useEffect, useState } from 'react';
import { useBuilderStore } from '@/store/builderStore';
import { getInscription, getOutput } from '@/lib/api/ordinals';
import SectionWrapper from './SectionWrapper';

export default function ParentSection() {
  const parentInscription = useBuilderStore((s) => s.parentInscription);
  const setParentInscription = useBuilderStore((s) => s.setParentInscription);
  const pendingParentId = useBuilderStore((s) => s.pendingParentId);
  const setPendingParentId = useBuilderStore((s) => s.setPendingParentId);
  const wallet = useBuilderStore((s) => s.wallet);
  const isTestnet = wallet.taprootAddress.startsWith('tb1');

  const [parentId, setParentId] = useState(parentInscription?.inscriptionId ?? pendingParentId ?? '');
  const [verifyState, setVerifyState] = useState<'idle' | 'loading' | 'ok' | 'error'>('idle');
  const [verifyError, setVerifyError] = useState('');

  // Sync local input from store when parent changes externally (bundle resume after re-resolve).
  useEffect(() => {
    if (parentInscription?.inscriptionId) setParentId(parentInscription.inscriptionId);
  }, [parentInscription?.inscriptionId]);

  const INSCRIPTION_ID_REGEX = /^[0-9a-fA-F]{64}i\d+$/;

  // Badge: truncated parent ID if verified
  let badge: string | undefined;
  if (parentInscription) {
    const id = parentInscription.inscriptionId;
    badge = `${id.slice(0, 8)}…${id.slice(-6)}`;
  }

  // --- Parent verify ---
  // Accepts an explicit ID so bundle-resume can call it without going through input state first.
  // Defensive: only treat explicitId as the source when it's actually a string — onClick passes
  // a MouseEvent, and bad persisted state could put a non-string here.
  async function handleParentVerify(explicitId?: string) {
    const source = typeof explicitId === 'string' ? explicitId : parentId;
    const id = source.trim();
    if (!INSCRIPTION_ID_REGEX.test(id)) {
      setVerifyState('error');
      setVerifyError('Invalid inscription ID format.');
      return;
    }
    setParentId(id);
    setVerifyState('loading');
    setVerifyError('');

    // On testnet, ordinals.com is mainnet-only — use the TXID from the inscription ID
    // to look up the UTXO via mempool API instead
    if (isTestnet) {
      try {
        const [txid, indexStr] = id.split('i');
        const vout = parseInt(indexStr, 10) || 0;
        // Use mempool API to verify the TX exists and get the output value
        const { fetchUtxos } = await import('@/lib/api/mempool');
        const utxos = await fetchUtxos(wallet.taprootAddress);
        const utxo = utxos.find(u => u.txid === txid && u.vout === vout);
        if (utxo) {
          setParentInscription({ inscriptionId: id, txid, vout, value: utxo.value, address: wallet.taprootAddress });
        } else {
          // UTXO not on our address — trust the user, use dummy value
          setParentInscription({ inscriptionId: id, txid, vout, value: 546, address: wallet.taprootAddress });
        }
        setVerifyState('ok');
      } catch (err) {
        setVerifyState('error');
        setVerifyError(err instanceof Error ? err.message : 'Failed to verify on testnet');
        setParentInscription(null);
      }
      return;
    }

    try {
      const info = await getInscription(id);
      const [txid, voutStr] = info.output.split(':');
      const vout = parseInt(voutStr, 10);
      const outputInfo = await getOutput(txid, vout);
      const ownerAddress = info.address;
      const isOwned = ownerAddress === wallet.taprootAddress || ownerAddress === wallet.paymentAddress;
      setParentInscription({ inscriptionId: id, txid, vout, value: outputInfo.value, address: ownerAddress });
      if (isOwned) {
        setVerifyState('ok');
      } else {
        setVerifyState('error');
        setVerifyError(`Parent not owned by signer. Current owner: ${ownerAddress.slice(0, 12)}…${ownerAddress.slice(-8)}`);
        setParentInscription(null);
      }
    } catch (err) {
      setVerifyState('error');
      setVerifyError(err instanceof Error ? err.message : 'Inscription not found');
      setParentInscription(null);
    }
  }

  function handleParentIdChange(val: string) {
    setParentId(val); setVerifyState('idle'); setVerifyError('');
    if (!val.trim()) setParentInscription(null);
  }

  // Bundle resume: when loadFromBundle sets pendingParentId but no live parentInscription,
  // re-resolve the parent UTXO automatically. RevealPhase will also re-resolve at sign time
  // (defense in depth) — this resolve is for accurate template fee + UI display.
  // Requires a connected wallet (testnet check + ownership compare depend on wallet address).
  useEffect(() => {
    if (!pendingParentId || parentInscription) return;
    if (!wallet.connected) return;
    handleParentVerify(pendingParentId).finally(() => setPendingParentId(null));
    // handleParentVerify is referentially unstable but its behavior only depends on wallet/store
    // values captured at call time; safe to omit from deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingParentId, parentInscription, wallet.connected]);

  return (
    <SectionWrapper sectionKey="parent" title="Parent Inscription" badge={badge}>
      <div className="flex flex-col gap-3">
        <label className="text-sm font-medium text-gray-300">
          Parent Inscription ID <span className="text-gray-500 font-normal">(optional)</span>
        </label>
        <p className="text-xs text-gray-500">Format: &lt;64-hex-chars&gt;i&lt;number&gt;</p>
        <div className="flex gap-2">
          <input
            type="text" value={parentId} onChange={(e) => handleParentIdChange(e.target.value)}
            placeholder="abc123...i0" spellCheck={false}
            className="flex-1 rounded-lg border border-gray-700 bg-gray-900 px-4 py-2.5 font-mono text-xs text-white placeholder-gray-600 focus:border-orange-500 focus:outline-none"
          />
          <button
            onClick={() => handleParentVerify()}
            disabled={!parentId.trim() || verifyState === 'loading'}
            className="rounded-lg border border-orange-500 px-4 py-2.5 text-sm font-semibold text-orange-500 hover:bg-orange-500 hover:text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors whitespace-nowrap"
          >
            {verifyState === 'loading' ? 'Verifying…' : 'Verify'}
          </button>
        </div>

        {verifyState === 'ok' && parentInscription && (
          <div className="rounded-lg border border-green-500/30 bg-green-500/10 px-4 py-3 flex flex-col gap-1">
            <span className="text-xs text-green-400 font-semibold">Verified</span>
            <span className="text-xs text-gray-400 font-mono break-all">Output: {parentInscription.txid}:{parentInscription.vout}</span>
          </div>
        )}

        {verifyState === 'error' && (
          <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3">
            <span className="text-xs text-red-400">{verifyError}</span>
          </div>
        )}
      </div>
    </SectionWrapper>
  );
}

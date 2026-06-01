'use client';

import { useEffect, useState } from 'react';
import { useBuilderStore } from '@/store/builderStore';
import { resolveParentInscription } from '@/lib/runes/resolveParent';
import SectionWrapper from './SectionWrapper';

export default function ParentSection() {
  const parentInscription = useBuilderStore((s) => s.parentInscription);
  const setParentInscription = useBuilderStore((s) => s.setParentInscription);
  const pendingParentId = useBuilderStore((s) => s.pendingParentId);
  const setPendingParentId = useBuilderStore((s) => s.setPendingParentId);
  const wallet = useBuilderStore((s) => s.wallet);

  const [parentId, setParentId] = useState(parentInscription?.inscriptionId ?? pendingParentId ?? '');
  const [verifyState, setVerifyState] = useState<'idle' | 'loading' | 'ok' | 'error'>('idle');
  const [verifyError, setVerifyError] = useState('');

  // Sync local input from store when parent changes externally (bundle resume after re-resolve).
  useEffect(() => {
    if (parentInscription?.inscriptionId) setParentId(parentInscription.inscriptionId);
  }, [parentInscription?.inscriptionId]);

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
    setParentId(id);
    setVerifyState('loading');
    setVerifyError('');

    const res = await resolveParentInscription(id, wallet);
    if (!res.ok) {
      setVerifyState('error');
      setVerifyError(res.error);
      setParentInscription(null);
      return;
    }
    if (!res.owned) {
      const owner = res.parent.address;
      setVerifyState('error');
      setVerifyError(`Parent not owned by signer. Current owner: ${owner.slice(0, 12)}…${owner.slice(-8)}`);
      setParentInscription(null);
      return;
    }
    setParentInscription(res.parent);
    setVerifyState('ok');
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

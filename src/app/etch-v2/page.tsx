'use client';

import { useEffect, useRef } from 'react';
import { useBuilderStore } from '@/store/builderStore';
import { parseBundle } from '@/lib/bundle/import';

import WalletHeader from '@/components/builder/WalletHeader';
import OrdHealthBanner from '@/components/builder/OrdHealthBanner';
import RuneDetailsSection from '@/components/builder/RuneDetailsSection';
import SupplyMintSection from '@/components/builder/SupplyMintSection';
import InscriptionSection from '@/components/builder/InscriptionSection';
import ParentSection from '@/components/builder/ParentSection';
import VanitySection from '@/components/builder/VanitySection';
import UtxoSection from '@/components/builder/UtxoSection';
import SatTargetSection from '@/components/builder/SatTargetSection';
import FeeRateSection from '@/components/builder/FeeRateSection';
import TxPreview from '@/components/builder/TxPreview';
import BuildButton from '@/components/builder/BuildButton';
import WaitingPhase from '@/components/builder/WaitingPhase';
import RevealPhase from '@/components/builder/RevealPhase';
import CompletePhase from '@/components/builder/CompletePhase';

export default function EtchV2Page() {
  const phase = useBuilderStore((s) => s.phase);
  const wallet = useBuilderStore((s) => s.wallet);
  const etching = useBuilderStore((s) => s.etching);
  const inscriptionFile = useBuilderStore((s) => s.inscriptionFile);
  const delegateInscriptionId = useBuilderStore((s) => s.delegateInscriptionId);
  const parentInscription = useBuilderStore((s) => s.parentInscription);
  const currentBlockHeight = useBuilderStore((s) => s.currentBlockHeight);
  const redetect = useBuilderStore((s) => s.redetect);
  const reset = useBuilderStore((s) => s.reset);
  const loadFromBundle = useBuilderStore((s) => s.loadFromBundle);
  const bundleFileRef = useRef<HTMLInputElement>(null);

  const isTestnet = wallet.taprootAddress.startsWith('tb1');

  // Re-run auto-detection on relevant state changes
  useEffect(() => {
    if (phase !== 'building') return;
    redetect();
  }, [phase, inscriptionFile, delegateInscriptionId, parentInscription, etching.runeName, currentBlockHeight, isTestnet, redetect]);

  // Auto-scroll to phase component when phase changes
  const phaseRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (phase !== 'building' && phaseRef.current) {
      phaseRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [phase]);

  function handleStartOver() {
    if (confirm('Start over? This will reset all progress. Your commit TX (if broadcast) is still safe on-chain.')) {
      reset();
    }
  }

  function handleBundleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target?.result as string;
      const bundle = parseBundle(text);
      if (!bundle) {
        alert('Invalid bundle file.');
        return;
      }
      loadFromBundle(bundle);
    };
    reader.readAsText(file);
  }

  return (
    <div className="min-h-screen bg-gray-950 text-white">
      <WalletHeader />
      <OrdHealthBanner />

      {/* Toolbar */}
      <div className="border-b border-gray-800 px-6 py-2">
        <div className="max-w-3xl mx-auto flex items-center justify-end gap-3">
          <button onClick={() => bundleFileRef.current?.click()}
            className="text-xs text-gray-500 hover:text-orange-400 transition-colors">
            Upload Bundle
          </button>
          <button onClick={handleStartOver}
            className="text-xs text-gray-500 hover:text-red-400 transition-colors">
            Start Over
          </button>
          <input ref={bundleFileRef} type="file" accept=".json" className="hidden" onChange={handleBundleUpload} />
        </div>
      </div>

      {/* Builder sections */}
      <main className="max-w-3xl mx-auto px-6 py-6 flex flex-col gap-4">
        <RuneDetailsSection />
        <SupplyMintSection />
        <InscriptionSection />
        <ParentSection />
        <VanitySection />
        <SatTargetSection />
        <UtxoSection />
        <FeeRateSection />

        {/* TX Preview + Build Button */}
        <TxPreview />
        <BuildButton />

        {/* Phase components */}
        <div ref={phaseRef}>
          {phase === 'waiting' && <WaitingPhase />}
          {phase === 'reveal' && <RevealPhase />}
          {phase === 'complete' && <CompletePhase />}
        </div>
      </main>
    </div>
  );
}

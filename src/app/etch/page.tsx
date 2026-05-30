'use client';

import { useRef, useState } from 'react';
import { useEtchStore } from '@/store/etchStore';
import { parseBundle } from '@/lib/bundle/import';
import type { WizardStep, EtchMode } from '@/types';

import ConnectWallet from '@/components/wizard/ConnectWallet';
import RuneDetails from '@/components/wizard/RuneDetails';
import MintTerms from '@/components/wizard/MintTerms';
import Inscription from '@/components/wizard/Inscription';
import UtxoSelector from '@/components/wizard/UtxoSelector';
import VanityAndFees from '@/components/wizard/VanityAndFees';
import ReviewAndSign from '@/components/wizard/ReviewAndSign';
import WaitingRoom from '@/components/wizard/WaitingRoom';
import RevealAndComplete from '@/components/wizard/RevealAndComplete';

interface StepDef {
  key: WizardStep;
  label: string;
}

function getStepsForMode(mode: EtchMode): StepDef[] {
  const steps: StepDef[] = [
    { key: 'connect',      label: 'Connect' },
    { key: 'rune-details', label: 'Rune'    },
    { key: 'mint-terms',   label: 'Mint'    },
  ];

  // Inscription step only for modes that use it
  if (mode === 'full' || mode === 'no-parent') {
    steps.push({ key: 'inscription', label: 'Inscribe' });
  }

  steps.push(
    { key: 'utxo-select',  label: 'UTXOs' },
    { key: 'vanity-fees',  label: 'Fees'  },
  );

  steps.push(
    { key: 'review',  label: 'Review'  },
    { key: 'waiting', label: 'Waiting' },
    { key: 'reveal',  label: 'Reveal'  },
  );

  return steps;
}

// Steps at or past this key cannot be navigated backward from
function getCommitStepKey(_mode: EtchMode): WizardStep {
  return 'waiting';
}

export default function EtchPage() {
  const step = useEtchStore((s) => s.step);
  const setStep = useEtchStore((s) => s.setStep);
  const etchMode = useEtchStore((s) => s.etchMode);
  const reset = useEtchStore((s) => s.reset);
  const loadFromBundle = useEtchStore((s) => s.loadFromBundle);
  const bundleFileRef = useRef<HTMLInputElement>(null);
  const [bundleError, setBundleError] = useState<string | null>(null);

  const steps = getStepsForMode(etchMode);
  const stepIndex: Record<string, number> = {};
  steps.forEach(({ key }, i) => { stepIndex[key] = i; });

  const currentIndex = stepIndex[step] ?? 0;
  const commitStepKey = getCommitStepKey(etchMode);
  const commitStepIndex = stepIndex[commitStepKey] ?? steps.length;

  function goNext() {
    if (currentIndex < steps.length - 1) {
      setStep(steps[currentIndex + 1].key);
    }
  }

  function goBack() {
    if (currentIndex > 0) {
      setStep(steps[currentIndex - 1].key);
    }
  }

  function handleStartOver() {
    if (confirm('Start over? This will reset all progress. Your commit TX (if broadcast) is still safe on-chain.')) {
      reset();
    }
  }

  function handleBundleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setBundleError(null);
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target?.result as string;
      const bundle = parseBundle(text);
      if (!bundle) {
        setBundleError('Invalid bundle file.');
        return;
      }
      loadFromBundle(bundle);
    };
    reader.readAsText(file);
  }

  function renderStep() {
    const props = { onNext: goNext, onBack: goBack };
    switch (step) {
      case 'connect':       return <ConnectWallet {...props} />;
      case 'rune-details':  return <RuneDetails {...props} />;
      case 'mint-terms':    return <MintTerms {...props} />;
      case 'inscription':   return <Inscription {...props} />;
      case 'utxo-select':   return <UtxoSelector {...props} />;
      case 'vanity-fees':   return <VanityAndFees {...props} />;
      case 'review':        return <ReviewAndSign {...props} />;
      case 'waiting':       return <WaitingRoom {...props} />;
      case 'reveal':        return <RevealAndComplete {...props} />;
    }
  }

  return (
    <div className="min-h-screen bg-gray-950 text-white">
      {/* Header */}
      <header className="border-b border-gray-800 px-6 py-4">
        <div className="max-w-3xl mx-auto flex items-center justify-between">
          <span className="font-bold text-orange-500 tracking-tight text-lg">Runes Etch</span>
          <div className="flex items-center gap-3">
            <button
              onClick={() => bundleFileRef.current?.click()}
              className="text-xs text-gray-500 hover:text-orange-400 transition-colors"
            >
              Upload Bundle
            </button>
            <button
              onClick={handleStartOver}
              className="text-xs text-gray-500 hover:text-red-400 transition-colors"
            >
              Start Over
            </button>
            <span className="text-sm text-gray-500">
              Step {currentIndex + 1}/{steps.length}
            </span>
          </div>
        </div>
        <input ref={bundleFileRef} type="file" accept=".json" className="hidden" onChange={handleBundleUpload} />
        {bundleError && (
          <div className="max-w-3xl mx-auto mt-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">
            {bundleError}
          </div>
        )}
      </header>

      {/* Step indicator */}
      <div className="border-b border-gray-800 px-6 py-4 overflow-x-auto">
        <div className="max-w-3xl mx-auto">
          <ol className="flex items-center min-w-max gap-0">
            {steps.map(({ key, label }, i) => {
              const isCompleted = i < currentIndex;
              const isCurrent = i === currentIndex;

              return (
                <li key={key} className="flex items-center">
                  <button
                    onClick={() => {
                      if (isCompleted && !(currentIndex >= commitStepIndex && i < commitStepIndex)) {
                        setStep(key);
                      }
                    }}
                    disabled={!isCompleted || (currentIndex >= commitStepIndex && i < commitStepIndex)}
                    className={`flex flex-col items-center gap-1 group ${isCompleted && !(currentIndex >= commitStepIndex && i < commitStepIndex) ? 'cursor-pointer' : 'cursor-default'}`}
                  >
                    <span
                      className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold transition-colors ${
                        isCurrent
                          ? 'bg-orange-500 text-white ring-2 ring-orange-500/40 ring-offset-2 ring-offset-gray-950'
                          : isCompleted
                          ? 'bg-orange-500/20 text-orange-400 group-hover:bg-orange-500/30'
                          : 'bg-gray-800 text-gray-600'
                      }`}
                    >
                      {isCompleted ? (
                        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                        </svg>
                      ) : (
                        i + 1
                      )}
                    </span>
                    <span
                      className={`text-xs whitespace-nowrap ${
                        isCurrent ? 'text-orange-400 font-medium' : isCompleted ? 'text-gray-400' : 'text-gray-600'
                      }`}
                    >
                      {label}
                    </span>
                  </button>

                  {i < steps.length - 1 && (
                    <span
                      className={`w-8 h-px mx-1 mb-4 shrink-0 transition-colors ${
                        i < currentIndex ? 'bg-orange-500/40' : 'bg-gray-800'
                      }`}
                    />
                  )}
                </li>
              );
            })}
          </ol>
        </div>
      </div>

      {/* Step content */}
      <main className="max-w-3xl mx-auto px-6 py-8">
        {renderStep()}
      </main>
    </div>
  );
}

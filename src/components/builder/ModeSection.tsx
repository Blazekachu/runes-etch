'use client';

import { useBuilderStore } from '@/store/builderStore';
import type { ProductMode } from '@/types';
import SectionWrapper from './SectionWrapper';

const MODES: Array<{ key: ProductMode; title: string; desc: string }> = [
  {
    key: 'parent-child',
    title: 'Parent Child',
    desc: 'Etch a rune with a child inscription linked to a parent inscription.',
  },
  {
    key: 'rune-inscription',
    title: 'Rune With Inscription',
    desc: 'Etch a rune with new file/text content or a delegate, with no parent lineage.',
  },
  {
    key: 'rune',
    title: 'Rune',
    desc: 'Etch only the rune name, supply, mint terms, and turbo flag.',
  },
];

export default function ModeSection() {
  const productMode = useBuilderStore((s) => s.productMode);
  const setProductMode = useBuilderStore((s) => s.setProductMode);
  const commitState = useBuilderStore((s) => s.commitState);

  return (
    <SectionWrapper sectionKey="mode" title="Mode" badge={MODES.find((m) => m.key === productMode)?.title}>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        {MODES.map((mode) => (
          <button
            key={mode.key}
            type="button"
            onClick={() => setProductMode(mode.key)}
            disabled={!!commitState}
            className={`rounded-lg border p-3 text-left transition-colors ${
              productMode === mode.key
                ? 'border-orange-500 bg-orange-500/10'
                : 'border-gray-700 bg-gray-900 hover:border-gray-600'
            } disabled:opacity-60 disabled:cursor-not-allowed`}
          >
            <p className={`text-sm font-semibold ${productMode === mode.key ? 'text-orange-400' : 'text-white'}`}>
              {mode.title}
            </p>
            <p className="text-xs text-gray-500 mt-1">{mode.desc}</p>
          </button>
        ))}
      </div>
    </SectionWrapper>
  );
}

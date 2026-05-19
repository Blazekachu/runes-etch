'use client';

import { useBuilderStore } from '@/store/builderStore';

interface SectionWrapperProps {
  sectionKey: string;
  title: string;
  badge?: string;
  required?: boolean;
  error?: boolean;
  disabled?: boolean;
  children: React.ReactNode;
}

export default function SectionWrapper({
  sectionKey,
  title,
  badge,
  required,
  error,
  disabled,
  children,
}: SectionWrapperProps) {
  const open = useBuilderStore((s) => s.openSections[sectionKey] ?? false);
  const toggleSection = useBuilderStore((s) => s.toggleSection);
  const phase = useBuilderStore((s) => s.phase);

  const isReadOnly = phase !== 'building';

  return (
    <div className={`rounded-lg border overflow-hidden transition-colors ${
      error ? 'border-red-500/50' : 'border-gray-800'
    } ${isReadOnly ? 'opacity-60' : ''}`}>
      <button
        type="button"
        onClick={() => toggleSection(sectionKey)}
        disabled={disabled}
        className="w-full flex items-center justify-between gap-3 px-5 py-3.5 bg-gray-900 hover:bg-gray-800/80 transition-colors disabled:cursor-not-allowed"
      >
        <div className="flex items-center gap-2.5 min-w-0">
          <span className="text-sm font-semibold text-white">{title}</span>
          {required && error && (
            <span className="w-2 h-2 rounded-full bg-red-500 shrink-0" />
          )}
          {badge && !open && (
            <span className="text-xs text-gray-400 font-mono truncate">{badge}</span>
          )}
          {isReadOnly && (
            <span className="text-xs text-gray-600">(locked)</span>
          )}
        </div>
        <svg
          className={`w-4 h-4 text-gray-500 shrink-0 transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
          fill="none" viewBox="0 0 24 24" stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {open && (
        <div className={`px-5 py-4 bg-gray-950 border-t border-gray-800 ${isReadOnly ? 'pointer-events-none' : ''}`}>
          {children}
        </div>
      )}
    </div>
  );
}

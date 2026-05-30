'use client';

import { useState } from 'react';
import { useBuilderStore } from '@/store/builderStore';
import { VanityGrinder } from '@/lib/vanity/grinder';
import type { VanityConfig } from '@/types';
import SectionWrapper from './SectionWrapper';

const MAX_VANITY_TOTAL = 6;

interface VanityPanelProps {
  label: string;
  helpText: string;
  config: VanityConfig;
  onChange: (config: VanityConfig) => void;
}

function VanityPanel({ label, helpText, config, onChange }: VanityPanelProps) {
  // Re-sanitize hydrated values in case localStorage was corrupted
  const [prefix, setPrefix] = useState(config.prefix.replace(/[^0-9a-f]/g, '').slice(0, 6));
  const [suffix, setSuffix] = useState(config.suffix.replace(/[^0-9a-f]/g, '').slice(0, 6));

  function handlePrefix(val: string) {
    const clean = val.toLowerCase().replace(/[^0-9a-f]/g, '');
    const maxLen = MAX_VANITY_TOTAL - suffix.length;
    const next = clean.slice(0, Math.max(0, maxLen));
    setPrefix(next);
    onChange({ prefix: next, suffix });
  }

  function handleSuffix(val: string) {
    const clean = val.toLowerCase().replace(/[^0-9a-f]/g, '');
    const maxLen = MAX_VANITY_TOTAL - prefix.length;
    const next = clean.slice(0, Math.max(0, maxLen));
    setSuffix(next);
    onChange({ prefix, suffix: next });
  }

  const totalVanityChars = prefix.length + suffix.length;
  const difficulty = VanityGrinder.estimateDifficulty(prefix, suffix);
  const hasVanity = totalVanityChars > 0;
  const previewMiddle = 'xxxxx';

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-gray-800 bg-gray-950/50 p-4">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium text-gray-300">{label}</p>
        {hasVanity && (
          <span className="font-mono text-xs text-orange-400">
            {prefix && `prefix: ${prefix}`}{prefix && suffix && ' · '}{suffix && `suffix: ${suffix}`}
          </span>
        )}
      </div>
      <p className="text-xs text-gray-500">{helpText}</p>

      <div className="flex gap-4">
        <div className="flex flex-col gap-1 flex-1">
          <label className="text-xs text-gray-500 uppercase tracking-wider">
            Prefix <span className="normal-case text-gray-600">({prefix.length}/{MAX_VANITY_TOTAL - suffix.length})</span>
          </label>
          <input
            type="text"
            value={prefix}
            onChange={(e) => handlePrefix(e.target.value)}
            placeholder="dead"
            spellCheck={false}
            className="rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 font-mono text-sm text-white placeholder-gray-700 focus:border-orange-500 focus:outline-none"
          />
        </div>
        <div className="flex flex-col gap-1 flex-1">
          <label className="text-xs text-gray-500 uppercase tracking-wider">
            Suffix <span className="normal-case text-gray-600">({suffix.length}/{MAX_VANITY_TOTAL - prefix.length})</span>
          </label>
          <input
            type="text"
            value={suffix}
            onChange={(e) => handleSuffix(e.target.value)}
            placeholder="cafe"
            spellCheck={false}
            className="rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 font-mono text-sm text-white placeholder-gray-700 focus:border-orange-500 focus:outline-none"
          />
        </div>
      </div>

      <div className="rounded-lg border border-gray-800 bg-gray-950 px-4 py-2">
        <p className="font-mono text-sm break-all">
          {prefix.length > 0 && <span className="text-orange-400">{prefix}</span>}
          <span className="text-gray-600">{previewMiddle}…</span>
          {suffix.length > 0 && <span className="text-orange-400">{suffix}</span>}
          {!hasVanity && <span className="text-gray-600">any txid</span>}
        </p>
      </div>

      {hasVanity && (
        <div className="flex items-center justify-between text-xs">
          <span className={`font-medium ${
            totalVanityChars <= 3 ? 'text-green-400' : totalVanityChars <= 5 ? 'text-yellow-400' : 'text-red-400'
          }`}>
            {difficulty.description}
          </span>
          <span className="font-mono text-gray-500">
            ~{difficulty.avgAttempts.toLocaleString()} attempts
          </span>
        </div>
      )}
    </div>
  );
}

export default function VanitySection() {
  const commitVanityConfig = useBuilderStore((s) => s.commitVanityConfig);
  const setCommitVanityConfig = useBuilderStore((s) => s.setCommitVanityConfig);

  // This section surfaces only COMMIT vanity — reveal vanity is set in WaitingPhase,
  // the phase where it actually applies. Reveal vanity is purely post-commit data
  // (varies the reveal TX nLockTime, signed only after commit confirms); the bundle
  // doesn't carry it, so pre-commit entry would silently vanish on bundle-import.
  const commitActive = commitVanityConfig.prefix.length + commitVanityConfig.suffix.length > 0;

  const badge: string | undefined = commitActive
    ? `commit: ${commitVanityConfig.prefix || ''}…${commitVanityConfig.suffix || ''}`
    : undefined;

  return (
    <SectionWrapper sectionKey="vanity" title="Vanity TXID" badge={badge}>
      <div className="flex flex-col gap-4">
        <p className="text-xs text-gray-500">
          Allowed: <span className="font-mono text-gray-400">0-9 a-f</span> (hex). Max{' '}
          <span className="text-gray-400">{MAX_VANITY_TOTAL}</span> chars (prefix + suffix). Grinder
          varies the 4-byte nLockTime in a Web Worker before signing.{' '}
          Reveal-TXID vanity is configured later in the Waiting phase — that's when it grinds.
        </p>

        <VanityPanel
          label="Commit TXID vanity"
          helpText="Grinds the commit TXID before signing. Runs locally in your browser; the commit broadcast waits for the match."
          config={commitVanityConfig}
          onChange={setCommitVanityConfig}
        />
      </div>
    </SectionWrapper>
  );
}

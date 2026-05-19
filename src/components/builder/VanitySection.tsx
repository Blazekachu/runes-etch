'use client';

import { useState } from 'react';
import { useBuilderStore } from '@/store/builderStore';
import { VanityGrinder } from '@/lib/vanity/grinder';
import SectionWrapper from './SectionWrapper';

export default function VanitySection() {
  const vanityConfig = useBuilderStore((s) => s.vanityConfig);
  const setVanityConfig = useBuilderStore((s) => s.setVanityConfig);

  // Re-sanitize hydrated values in case localStorage was corrupted
  const [prefix, setPrefix] = useState(vanityConfig.prefix.replace(/[^0-9a-f]/g, '').slice(0, 6));
  const [suffix, setSuffix] = useState(vanityConfig.suffix.replace(/[^0-9a-f]/g, '').slice(0, 6));

  const MAX_VANITY_TOTAL = 6;

  function handlePrefix(val: string) {
    const clean = val.toLowerCase().replace(/[^0-9a-f]/g, '');
    const maxLen = MAX_VANITY_TOTAL - suffix.length;
    const next = clean.slice(0, Math.max(0, maxLen));
    setPrefix(next);
    setVanityConfig({ prefix: next, suffix });
  }

  function handleSuffix(val: string) {
    const clean = val.toLowerCase().replace(/[^0-9a-f]/g, '');
    const maxLen = MAX_VANITY_TOTAL - prefix.length;
    const next = clean.slice(0, Math.max(0, maxLen));
    setSuffix(next);
    setVanityConfig({ prefix, suffix: next });
  }

  const totalVanityChars = prefix.length + suffix.length;
  const difficulty = VanityGrinder.estimateDifficulty(prefix, suffix);
  const hasVanity = totalVanityChars > 0;
  const previewMiddle = 'xxxxx';

  const badge = hasVanity
    ? `prefix: ${prefix || '—'}${suffix ? ` suffix: ${suffix}` : ''}`
    : undefined;

  return (
    <SectionWrapper sectionKey="vanity" title="Vanity TXID" badge={badge}>
      <div className="flex flex-col gap-4">
        <div>
          <p className="text-xs text-gray-500 mt-1">
            Allowed characters: <span className="font-mono text-gray-400">0-9 a-f</span> (hex only).
            Max <span className="text-gray-400">{MAX_VANITY_TOTAL}</span> characters total across prefix + suffix.
          </p>
        </div>

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

        {/* Character budget */}
        {hasVanity && (
          <div className="flex items-center justify-between text-xs">
            <span className="text-gray-500">Characters used</span>
            <span className={`font-mono font-medium ${totalVanityChars >= MAX_VANITY_TOTAL ? 'text-orange-400' : 'text-gray-300'}`}>
              {totalVanityChars} / {MAX_VANITY_TOTAL}
            </span>
          </div>
        )}

        {/* Preview */}
        <div className="rounded-lg border border-gray-800 bg-gray-950 px-4 py-3">
          <p className="text-xs text-gray-500 mb-1">TXID Preview</p>
          <p className="font-mono text-sm break-all">
            {prefix.length > 0 && (
              <span className="text-orange-400">{prefix}</span>
            )}
            <span className="text-gray-600">{previewMiddle}…</span>
            {suffix.length > 0 && (
              <span className="text-orange-400">{suffix}</span>
            )}
            {!hasVanity && (
              <span className="text-gray-600">any txid</span>
            )}
          </p>
        </div>

        {/* Difficulty */}
        {hasVanity && (
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between text-xs">
              <span className="text-gray-500">Difficulty</span>
              <span className={`font-medium ${
                totalVanityChars <= 3
                  ? 'text-green-400'
                  : totalVanityChars <= 5
                  ? 'text-yellow-400'
                  : 'text-red-400'
              }`}>
                {difficulty.description}
              </span>
            </div>
            <p className="text-xs text-gray-600 font-mono">
              ~{difficulty.avgAttempts.toLocaleString()} avg attempts
            </p>
            {totalVanityChars >= 5 && (
              <p className="text-xs text-yellow-400">
                {totalVanityChars >= 6
                  ? 'This may take several minutes. The grinder uses 4 bytes (nLockTime), so 6 chars is near the practical limit.'
                  : '5 characters will take some time. Consider fewer characters for faster results.'}
              </p>
            )}
          </div>
        )}
      </div>
    </SectionWrapper>
  );
}

'use client';

import { useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { parseBundle } from '@/lib/bundle/import';
import { useEtchStore } from '@/store/etchStore';

export default function Home() {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [bundleError, setBundleError] = useState<string | null>(null);
  const loadFromBundle = useEtchStore((s) => s.loadFromBundle);

  function handleBundleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setBundleError(null);

    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target?.result as string;
      const bundle = parseBundle(text);
      if (!bundle) {
        setBundleError('Invalid bundle file. Expected a .runes.json file from a previous commit.');
        return;
      }
      loadFromBundle(bundle);
      router.push('/etch');
    };
    reader.readAsText(file);
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-gray-950 text-white">
      <div className="max-w-xl text-center space-y-6">
        <h1 className="text-5xl font-bold">Runes Etch</h1>
        <p className="text-lg text-gray-400">
          Self-custodial Bitcoin Runes etching. Etch your rune with a custom
          inscription, parent-child linkage, vanity TXID, and full UTXO control.
        </p>
        <div className="flex flex-col items-center gap-3">
          <Link
            href="/etch"
            className="inline-block rounded-lg bg-orange-500 px-8 py-4 text-lg font-semibold hover:bg-orange-600"
          >
            Start Etching
          </Link>
          <button
            onClick={() => fileRef.current?.click()}
            className="rounded-lg border border-gray-700 px-6 py-3 text-sm font-semibold text-gray-400 hover:border-orange-500 hover:text-orange-400 transition-colors"
          >
            Resume From Bundle
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".json"
            className="hidden"
            onChange={handleBundleFile}
          />
        </div>

        {bundleError && (
          <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400">
            {bundleError}
          </div>
        )}

        <p className="text-xs text-gray-600">
          Powered by bitcoinjs-lib. No backend. Your keys, your runes.
        </p>
      </div>
    </div>
  );
}

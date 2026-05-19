'use client';

import { useState } from 'react';
import { connectWallet, type WalletProvider } from '@/lib/wallet/xverse';
import { useEtchStore } from '@/store/etchStore';
import { setMempoolNetwork } from '@/lib/api/mempool';
import { setOrdinalsTestnet } from '@/lib/api/ordinals';
import type { EtchMode } from '@/types';

const MODES: { key: EtchMode; title: string; desc: string; badge?: string }[] = [
  {
    key: 'full',
    title: 'Full Etch',
    desc: 'Inscription + parent linkage + commit-reveal protection.',
  },
  {
    key: 'no-parent',
    title: 'No Parent',
    desc: 'Inscription without parent linkage. Commit-reveal protected.',
  },
  {
    key: 'no-inscription',
    title: 'No Inscription',
    desc: 'Pure rune etch with no inscription data. Commit-reveal protected.',
  },
  {
    key: 'quick',
    title: 'Quick Etch',
    desc: 'Single transaction, no commit-reveal. Name visible in mempool.',
    badge: 'No front-run protection',
  },
];

export default function ConnectWallet({ onNext }: { onNext?: () => void; onBack?: () => void }) {
  const wallet = useEtchStore((s) => s.wallet);
  const setWallet = useEtchStore((s) => s.setWallet);
  const etchMode = useEtchStore((s) => s.etchMode);
  const setEtchMode = useEtchStore((s) => s.setEtchMode);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleConnect(provider: WalletProvider = 'sats-connect') {
    setLoading(true);
    setError(null);
    try {
      const w = await connectWallet(provider);
      await setMempoolNetwork(w.taprootAddress);
      setOrdinalsTestnet(w.taprootAddress);
      setWallet(w);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to connect wallet');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-col items-center gap-8 py-12">
      <div className="flex flex-col items-center gap-3">
        <div className="w-16 h-16 rounded-full bg-orange-500/20 flex items-center justify-center">
          <svg className="w-8 h-8 text-orange-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
          </svg>
        </div>
        <h2 className="text-2xl font-bold text-white">Connect Your Wallet</h2>
        <p className="text-gray-400 text-sm text-center max-w-sm">
          Connect your wallet to get started etching a rune on Bitcoin.
        </p>
      </div>

      {error && (
        <div className="w-full max-w-md rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400">
          {error}
        </div>
      )}

      {wallet.connected ? (
        <div className="flex flex-col items-center gap-6 w-full max-w-lg">
          <div className="w-full rounded-lg border border-gray-700 bg-gray-900 p-4 flex flex-col gap-3">
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-green-500 shrink-0" />
              <span className="text-sm text-green-400 font-medium">Connected</span>
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-xs text-gray-500 uppercase tracking-wider">Taproot / Ordinals</span>
              <span className="font-mono text-xs text-gray-300 break-all">{wallet.taprootAddress}</span>
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-xs text-gray-500 uppercase tracking-wider">Payment</span>
              <span className="font-mono text-xs text-gray-300 break-all">{wallet.paymentAddress}</span>
            </div>
          </div>

          {/* Mode selection */}
          <div className="w-full flex flex-col gap-3">
            <p className="text-sm font-medium text-gray-300">Etching Mode</p>
            <div className="grid grid-cols-2 gap-2">
              {MODES.map((m) => (
                <button
                  key={m.key}
                  onClick={() => setEtchMode(m.key)}
                  className={`rounded-lg border p-3 text-left transition-colors ${
                    etchMode === m.key
                      ? 'border-orange-500 bg-orange-500/10'
                      : 'border-gray-700 bg-gray-900 hover:border-gray-600'
                  }`}
                >
                  <p className={`text-sm font-semibold ${etchMode === m.key ? 'text-orange-400' : 'text-white'}`}>
                    {m.title}
                  </p>
                  <p className="text-xs text-gray-500 mt-0.5">{m.desc}</p>
                  {m.badge && (
                    <span className="inline-block mt-1.5 rounded bg-yellow-500/20 px-1.5 py-0.5 text-xs text-yellow-400 font-medium">
                      {m.badge}
                    </span>
                  )}
                </button>
              ))}
            </div>
          </div>

          <button
            onClick={onNext}
            className="w-full rounded-lg bg-orange-500 hover:bg-orange-400 active:bg-orange-600 px-6 py-3 font-semibold text-white transition-colors"
          >
            Continue
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-3 w-full max-w-sm">
          <button
            onClick={() => handleConnect('sats-connect')}
            disabled={loading}
            className="w-full rounded-lg bg-orange-500 hover:bg-orange-400 active:bg-orange-600 disabled:opacity-50 disabled:cursor-not-allowed px-8 py-3 font-semibold text-white transition-colors flex items-center justify-center gap-2"
          >
            {loading && (
              <svg className="animate-spin w-4 h-4" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
              </svg>
            )}
            {loading ? 'Connecting…' : 'Connect Xverse'}
          </button>
          <button
            onClick={() => handleConnect('leather')}
            disabled={loading}
            className="w-full rounded-lg border border-gray-700 hover:border-orange-500 hover:text-orange-400 disabled:opacity-50 disabled:cursor-not-allowed px-8 py-3 font-semibold text-gray-300 transition-colors flex items-center justify-center gap-2"
          >
            {loading ? 'Connecting…' : 'Connect Leather'}
          </button>
        </div>
      )}
    </div>
  );
}

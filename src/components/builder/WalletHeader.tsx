'use client';

import { useState } from 'react';
import { connectWallet, type WalletProvider } from '@/lib/wallet/xverse';
import { useBuilderStore } from '@/store/builderStore';
import { setMempoolNetwork, getCurrentBlockHeight } from '@/lib/api/mempool';
import { setOrdinalsTestnet } from '@/lib/api/ordinals';

export default function WalletHeader() {
  const wallet = useBuilderStore((s) => s.wallet);
  const setWallet = useBuilderStore((s) => s.setWallet);
  const setCurrentBlockHeight = useBuilderStore((s) => s.setCurrentBlockHeight);
  const setSection = useBuilderStore((s) => s.setSection);
  const phase = useBuilderStore((s) => s.phase);
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
      setSection('utxo', true);
      try {
        const h = await getCurrentBlockHeight();
        setCurrentBlockHeight(h);
      } catch { /* non-fatal */ }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to connect wallet');
    } finally {
      setLoading(false);
    }
  }

  function truncate(addr: string) {
    if (addr.length <= 20) return addr;
    return `${addr.slice(0, 10)}…${addr.slice(-8)}`;
  }

  return (
    <header className="sticky top-0 z-10 border-b border-gray-800 bg-gray-950/95 backdrop-blur-sm px-6 py-3">
      <div className="max-w-3xl mx-auto flex items-center justify-between gap-4">
        <span className="font-bold text-orange-500 tracking-tight text-lg shrink-0">Runes Etch</span>

        {wallet.connected ? (
          <div className="flex items-center gap-3 min-w-0">
            <span className="w-2 h-2 rounded-full bg-green-500 shrink-0" />
            <div className="flex flex-col gap-0.5 min-w-0">
              <span className="font-mono text-xs text-gray-300 truncate">{truncate(wallet.taprootAddress)}</span>
              <span className="font-mono text-xs text-gray-500 truncate">{truncate(wallet.paymentAddress)}</span>
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <button
              onClick={() => handleConnect('sats-connect')}
              disabled={loading || phase !== 'building'}
              className="rounded-lg bg-orange-500 hover:bg-orange-400 disabled:opacity-50 disabled:cursor-not-allowed px-4 py-1.5 text-sm font-semibold text-white transition-colors"
            >
              {loading ? 'Connecting…' : 'Xverse'}
            </button>
            <button
              onClick={() => handleConnect('leather')}
              disabled={loading || phase !== 'building'}
              className="rounded-lg border border-gray-700 hover:border-orange-500 hover:text-orange-400 disabled:opacity-50 disabled:cursor-not-allowed px-4 py-1.5 text-sm font-semibold text-gray-300 transition-colors"
            >
              Leather
            </button>
          </div>
        )}
      </div>
      {error && (
        <div className="max-w-3xl mx-auto mt-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">
          {error}
        </div>
      )}
    </header>
  );
}

'use client';

import { useState, useEffect } from 'react';
import { connectWallet, disconnectWallet, addRegtestNetworkToXverse, type WalletProvider } from '@/lib/wallet/xverse';
import { useBuilderStore } from '@/store/builderStore';
import { setMempoolNetwork, getCurrentBlockHeightForWallet } from '@/lib/api/mempool';
import { setOrdinalsForWallet } from '@/lib/api/ordinals';
import { chainLabel, walletChain } from '@/lib/network';

export default function WalletHeader() {
  const wallet = useBuilderStore((s) => s.wallet);
  const setWallet = useBuilderStore((s) => s.setWallet);
  const setCurrentBlockHeight = useBuilderStore((s) => s.setCurrentBlockHeight);
  const setSection = useBuilderStore((s) => s.setSection);
  const phase = useBuilderStore((s) => s.phase);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const chain = wallet.connected ? walletChain(wallet) : null;

  // Re-arm module-level mempool + ordinals network state whenever a connected
  // wallet appears — covers persist-rehydration where handleConnect doesn't run.
  // Idempotent: safe to re-run on the same address (fresh connect already did it).
  useEffect(() => {
    if (!wallet.connected || !wallet.taprootAddress) return;
    const activeChain = walletChain(wallet);
    setMempoolNetwork(activeChain).catch(() => {});
    setOrdinalsForWallet(wallet);
  }, [wallet.connected, wallet.taprootAddress, wallet.network]);

  async function handleConnect(provider: WalletProvider = 'sats-connect') {
    setLoading(true);
    setError(null);
    try {
      const w = await connectWallet(provider);
      const activeChain = walletChain(w);
      await setMempoolNetwork(activeChain);
      setOrdinalsForWallet(w);
      setWallet(w);
      setSection('utxo', true);
      try {
        const h = await getCurrentBlockHeightForWallet(w);
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
              <div className="flex items-center gap-2 min-w-0">
                <span className="font-mono text-xs text-gray-300 truncate">{truncate(wallet.taprootAddress)}</span>
                {chain && (
                  <span className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide bg-gray-800 text-gray-400">
                    {chainLabel(chain)}
                  </span>
                )}
              </div>
              <span className="font-mono text-xs text-gray-500 truncate">{truncate(wallet.paymentAddress)}</span>
            </div>
            <button
              onClick={() => setWallet(disconnectWallet())}
              title="Disconnect wallet"
              aria-label="Disconnect wallet"
              className="shrink-0 rounded-md border border-gray-700 hover:border-red-500 hover:text-red-400 text-gray-500 transition-colors w-6 h-6 flex items-center justify-center text-sm leading-none"
            >
              ×
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <button
              onClick={async () => {
                setLoading(true);
                setError(null);
                try {
                  await addRegtestNetworkToXverse(true);
                } catch (err) {
                  setError(err instanceof Error ? err.message : 'Failed to add regtest network');
                } finally {
                  setLoading(false);
                }
              }}
              disabled={loading || phase !== 'building'}
              className="rounded-lg border border-gray-700 hover:border-yellow-500 hover:text-yellow-400 disabled:opacity-50 disabled:cursor-not-allowed px-3 py-1.5 text-xs font-semibold text-gray-400 transition-colors"
              title="Add local regtest network to Xverse (esplora :18443, bitcoind RPC :18444)"
            >
              + Regtest
            </button>
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

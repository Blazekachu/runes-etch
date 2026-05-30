'use client';

import { useBuilderStore } from '@/store/builderStore';

function mempoolTxUrl(address: string): string {
  if (address.startsWith('tb1') || address.startsWith('2') || address.startsWith('m') || address.startsWith('n')) {
    return 'https://mempool.space/testnet4/tx';
  }
  return 'https://mempool.space/tx';
}

const ORDINALS_URL = 'https://ordinals.com/inscription';

export default function CompletePhase() {
  const etching = useBuilderStore((s) => s.etching);
  const revealTxid = useBuilderStore((s) => s.revealTxid);
  const commitState = useBuilderStore((s) => s.commitState);
  const wallet = useBuilderStore((s) => s.wallet);
  const reset = useBuilderStore((s) => s.reset);

  const txid = revealTxid || '';
  const MEMPOOL_TX_URL = mempoolTxUrl(wallet.taprootAddress || wallet.paymentAddress);

  return (
    <div className="flex flex-col gap-6 items-center text-center py-8">
      <div className="flex items-center justify-center w-20 h-20 rounded-full bg-green-500/15 border border-green-500/30">
        <svg className="w-10 h-10 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
        </svg>
      </div>

      <div>
        <h2 className="text-2xl font-bold text-white mb-2">Rune Etched!</h2>
        <p className="text-gray-400 text-sm">
          Your rune has been etched on Bitcoin. It may take a moment to appear on explorers.
        </p>
      </div>

      <div className="w-full rounded-lg border border-gray-800 bg-gray-900 px-6 py-4">
        <p className="text-xs text-gray-500 mb-1 uppercase tracking-wider">Rune Name</p>
        <p className="font-mono text-xl font-bold text-orange-400">{etching.runeName}</p>
      </div>

      <div className="w-full rounded-lg border border-gray-800 bg-gray-900 px-4 py-3">
        <p className="text-xs text-gray-500 mb-1">Reveal TXID</p>
        <p className="font-mono text-xs text-white break-all">{txid}</p>
      </div>

      {commitState && (
        <div className="w-full rounded-lg border border-gray-800 bg-gray-900 px-4 py-3">
          <p className="text-xs text-gray-500 mb-1">Commit TXID</p>
          <p className="font-mono text-xs text-gray-400 break-all">{commitState.txid}</p>
        </div>
      )}

      <div className="flex gap-3 w-full">
        <a href={`${MEMPOOL_TX_URL}/${txid}`} target="_blank" rel="noopener noreferrer"
          className="flex-1 rounded-lg border border-gray-700 px-4 py-2.5 text-sm font-semibold text-gray-300 hover:border-orange-500 hover:text-orange-400 transition-colors text-center">
          mempool.space
        </a>
        <a href={`${ORDINALS_URL}/${txid}i0`} target="_blank" rel="noopener noreferrer"
          className="flex-1 rounded-lg border border-gray-700 px-4 py-2.5 text-sm font-semibold text-gray-300 hover:border-orange-500 hover:text-orange-400 transition-colors text-center">
          ordinals.com
        </a>
      </div>

      <button onClick={reset}
        className="w-full rounded-lg border border-gray-700 px-6 py-2.5 text-sm font-semibold text-gray-300 hover:border-gray-500 hover:text-white transition-colors">
        Etch Another Rune
      </button>
    </div>
  );
}

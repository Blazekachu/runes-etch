'use client';

import { useBuilderStore } from '@/store/builderStore';

export default function TxPreview() {
  const etching = useBuilderStore((s) => s.etching);
  const inscriptionFile = useBuilderStore((s) => s.inscriptionFile);
  const delegateInscriptionId = useBuilderStore((s) => s.delegateInscriptionId);
  const parentInscription = useBuilderStore((s) => s.parentInscription);
  const detectedReason = useBuilderStore((s) => s.detectedReason);
  // Subscribe to `utxos` (the data), not the selectedUtxos() selector fn — the fn ref
  // is stable, so subscribing to it wouldn't re-render on a selection toggle (#7).
  const utxos = useBuilderStore((s) => s.utxos);
  const selectedFeeRate = useBuilderStore((s) => s.selectedFeeRate);

  const selected = utxos.filter((u) => u.selected);
  const totalIn = selected.reduce((acc, u) => acc + u.value, 0);
  const hasInscription = !!inscriptionFile || !!delegateInscriptionId;
  const hasParent = !!parentInscription;

  if (!etching.runeName) return null;

  const outputs: { label: string; dest: string }[] = [];
  if (etching.premine > 0n) {
    outputs.push({ label: 'Rune dust (546 sats)', dest: 'taproot' });
  }
  if (hasParent) {
    outputs.push({ label: 'Parent return (546 sats)', dest: 'taproot' });
  }
  outputs.push({ label: 'OP_RETURN runestone', dest: 'script' });
  outputs.push({ label: 'Change', dest: 'payment' });

  return (
    <div className="rounded-lg border border-gray-800 bg-gray-900 p-4 flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium text-gray-300">TX Preview</p>
        <span className="text-xs font-semibold px-2 py-0.5 rounded bg-orange-500/20 text-orange-400">
          Commit-Reveal
        </span>
      </div>
      <p className="text-xs text-gray-500">{detectedReason}</p>
      <div className="flex flex-col gap-1.5">
        {outputs.map((o, i) => (
          <div key={i} className="flex items-center justify-between text-xs">
            <span className="text-gray-400">{o.label}</span>
            <span className="font-mono text-gray-500">&rarr; {o.dest}</span>
          </div>
        ))}
      </div>
      {selected.length > 0 && (
        <div className="flex items-center justify-between text-xs pt-2 border-t border-gray-800">
          <span className="text-gray-400">{selected.length} input{selected.length !== 1 ? 's' : ''}</span>
          <span className="font-mono text-gray-300">{totalIn.toLocaleString()} sats @ {selectedFeeRate} sat/vB</span>
        </div>
      )}
    </div>
  );
}

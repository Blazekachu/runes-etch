'use client';

import { useBuilderStore } from '@/store/builderStore';

export default function TxPreview() {
  const etching = useBuilderStore((s) => s.etching);
  const productMode = useBuilderStore((s) => s.productMode);
  const parentInscription = useBuilderStore((s) => s.parentInscription);
  const detectedReason = useBuilderStore((s) => s.detectedReason);
  const phase = useBuilderStore((s) => s.phase);
  const commitState = useBuilderStore((s) => s.commitState);
  const utxos = useBuilderStore((s) => s.utxos);
  const selectedFeeRate = useBuilderStore((s) => s.selectedFeeRate);

  const hasParent = productMode === 'parent-child' && !!parentInscription;
  const isRevealPhase = phase === 'waiting' || phase === 'reveal' || phase === 'complete';

  if (!etching.runeName) return null;

  const outputs: { label: string; dest: string }[] = [];
  if (etching.premine > 0n) {
    outputs.push({ label: 'Rune dust (546 sats)', dest: 'taproot' });
  }
  if (hasParent) {
    outputs.push({ label: `Parent return (${parentInscription.value.toLocaleString()} sats)`, dest: 'taproot' });
  }
  outputs.push({ label: 'OP_RETURN runestone', dest: 'script' });
  outputs.push({ label: 'Change', dest: 'payment' });

  const modeLabel = productMode === 'parent-child'
    ? 'Parent Child'
    : productMode === 'rune-inscription'
      ? 'Rune With Inscription'
      : 'Rune';

  if (isRevealPhase && commitState) {
    const inputs: { label: string; value: number }[] = [];
    if (hasParent && parentInscription) {
      inputs.push({
        label: `Parent UTXO (${parentInscription.txid.slice(0, 8)}…:${parentInscription.vout})`,
        value: parentInscription.value,
      });
    }
    inputs.push({
      label: `Commit UTXO (${commitState.txid.slice(0, 8)}…:${commitState.commitOutputIndex})`,
      value: commitState.commitOutputValue,
    });
    const totalIn = inputs.reduce((acc, i) => acc + i.value, 0);

    return (
      <div className="rounded-lg border border-gray-800 bg-gray-900 p-4 flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <p className="text-sm font-medium text-gray-300">Reveal TX Preview</p>
          <span className="text-xs font-semibold px-2 py-0.5 rounded bg-orange-500/20 text-orange-400">
            {modeLabel}
          </span>
        </div>
        <p className="text-xs text-gray-500">{detectedReason}</p>
        <div className="flex flex-col gap-1.5">
          {inputs.map((input, i) => (
            <div key={i} className="flex items-center justify-between text-xs gap-3">
              <span className="text-gray-400 truncate">{input.label}</span>
              <span className="font-mono text-gray-300 shrink-0">{input.value.toLocaleString()} sats</span>
            </div>
          ))}
        </div>
        <div className="flex flex-col gap-1.5 pt-2 border-t border-gray-800">
          {outputs.map((o, i) => (
            <div key={i} className="flex items-center justify-between text-xs">
              <span className="text-gray-400">{o.label}</span>
              <span className="font-mono text-gray-500">&rarr; {o.dest}</span>
            </div>
          ))}
        </div>
        <div className="flex items-center justify-between text-xs pt-2 border-t border-gray-800">
          <span className="text-gray-400">{inputs.length} input{inputs.length !== 1 ? 's' : ''}</span>
          <span className="font-mono text-gray-300">{totalIn.toLocaleString()} sats @ {selectedFeeRate} sat/vB</span>
        </div>
      </div>
    );
  }

  const selected = utxos.filter((u) => u.selected);
  const totalIn = selected.reduce((acc, u) => acc + u.value, 0);

  return (
    <div className="rounded-lg border border-gray-800 bg-gray-900 p-4 flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium text-gray-300">Commit TX Preview</p>
        <span className="text-xs font-semibold px-2 py-0.5 rounded bg-orange-500/20 text-orange-400">
          {modeLabel}
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

import { beforeEach, describe, expect, it } from 'vitest';
import { useBuilderStore } from '../builderStore';

const parent = {
  inscriptionId: `${'a'.repeat(64)}i0`,
  txid: 'b'.repeat(64),
  vout: 0,
  value: 10_000,
  address: 'tb1ptestparent',
};

const textInscription = {
  contentType: 'text/plain;charset=utf-8',
  body: new TextEncoder().encode('test child'),
};

describe('builderStore product mode', () => {
  beforeEach(() => {
    localStorage.clear();
    useBuilderStore.getState().reset();
  });

  it('clears parent lineage when switching to rune-with-inscription mode', () => {
    const store = useBuilderStore.getState();

    store.setProductMode('parent-child');
    store.setParentInscription(parent);
    store.setInscriptionFile(textInscription);

    useBuilderStore.getState().setProductMode('rune-inscription');

    const state = useBuilderStore.getState();
    expect(state.productMode).toBe('rune-inscription');
    expect(state.parentInscription).toBeNull();
    expect(state.pendingParentId).toBeNull();
    expect(state.inscriptionFile).toEqual(textInscription);
  });

  it('clears all inscription and parent state when switching to pure rune mode', () => {
    const store = useBuilderStore.getState();

    store.setProductMode('parent-child');
    store.setParentInscription(parent);
    store.setInscriptionFile(textInscription);
    store.setDelegateInscriptionId(`${'c'.repeat(64)}i0`);

    useBuilderStore.getState().setProductMode('rune');

    const state = useBuilderStore.getState();
    expect(state.productMode).toBe('rune');
    expect(state.parentInscription).toBeNull();
    expect(state.pendingParentId).toBeNull();
    expect(state.inscriptionFile).toBeNull();
    expect(state.delegateInscriptionId).toBeNull();
  });

  it('treats pure rune mode as ready even if stale parent resume state survived refresh', () => {
    const store = useBuilderStore.getState();

    store.setProductMode('rune');
    store.setPendingParentId(`${'d'.repeat(64)}i0`);

    expect(useBuilderStore.getState().isProductModeReady()).toBe(true);
  });

  it('requires child content for parent-child mode', () => {
    const store = useBuilderStore.getState();

    store.setProductMode('parent-child');
    store.setParentInscription(parent);

    expect(useBuilderStore.getState().isProductModeReady()).toBe(false);

    useBuilderStore.getState().setInscriptionFile(textInscription);

    expect(useBuilderStore.getState().isProductModeReady()).toBe(true);
  });

  it('persists saved bundle state across refreshes', () => {
    useBuilderStore.getState().setBundleDownloaded(true);

    const raw = localStorage.getItem('runes-etch-v2-store');
    expect(raw).not.toBeNull();
    const persisted = JSON.parse(raw!);
    expect(persisted.state.bundleDownloaded).toBe(true);
  });

  it('loadFromBundle clears commit-funding UTXO picker state', () => {
    const store = useBuilderStore.getState();
    store.setUtxos([{
      txid: 'a'.repeat(64),
      vout: 904,
      value: 158_990,
      status: { confirmed: true },
      source: 'payment',
      label: 'plain',
      selected: true,
    }]);
    store.setTargetInput('abc');
    store.setTargetUtxo({
      txid: 'b'.repeat(64),
      vout: 0,
      value: 546,
      satNumber: null,
      inscriptionIds: [`${'c'.repeat(64)}i0`],
      runeNames: [],
    });

    useBuilderStore.getState().loadFromBundle({
      version: 1,
      type: 'runes-etch-commit',
      createdAt: new Date().toISOString(),
      network: 'signet',
      commitTxid: 'd'.repeat(64),
      commitOutputIndex: 0,
      commitOutputValue: 12_000,
      runeName: 'AAAAAAAAAAAA',
      targetUnlockHeight: 100_000,
      tapscriptHex: '51',
      controlBlockHex: 'c0',
      internalPubkeyHex: '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
      inscriptionFile: null,
      delegateInscriptionId: null,
      parentInscriptionId: `${'e'.repeat(64)}i0`,
      etching: {
        spacers: 0,
        symbol: 'T',
        divisibility: 0,
        premine: '1',
        terms: {
          amount: '1',
          cap: '10',
          heightStart: null,
          heightEnd: null,
          offsetStart: null,
          offsetEnd: null,
        },
        turbo: false,
      },
    });

    const state = useBuilderStore.getState();
    expect(state.phase).toBe('waiting');
    expect(state.utxos).toEqual([]);
    expect(state.targetUtxo).toBeNull();
    expect(state.targetInput).toBe('');
    expect(state.detectedReason).toBe('Resumed from commit bundle');
  });
});

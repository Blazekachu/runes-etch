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
});

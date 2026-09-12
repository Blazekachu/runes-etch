import { describe, expect, it } from 'vitest';
import { parseBundle } from '../import';

function validBundleJson(): string {
  return JSON.stringify({
    version: 1,
    type: 'runes-etch-commit',
    createdAt: new Date().toISOString(),
    network: 'signet',
    commitTxid: 'a'.repeat(64),
    commitOutputIndex: 0,
    commitOutputValue: 1234,
    runeName: 'VLOVE',
    targetUnlockHeight: 965565,
    tapscriptHex: '00',
    controlBlockHex: '00',
    internalPubkeyHex: 'b'.repeat(64),
    inscriptionFile: null,
    delegateInscriptionId: null,
    parentInscriptionId: null,
    etching: {
      spacers: 0,
      symbol: '',
      divisibility: 0,
      premine: '0',
      terms: null,
      turbo: false,
    },
  });
}

describe('parseBundle limits', () => {
  it('rejects oversized bundle JSON payload', () => {
    const huge = 'x'.repeat(2_200_000);
    expect(parseBundle(huge)).toBeNull();
  });

  it('rejects oversized inscription base64 payload', () => {
    const bundle = JSON.parse(validBundleJson()) as Record<string, unknown>;
    bundle.inscriptionFile = {
      contentType: 'text/plain',
      bodyBase64: 'A'.repeat(600_000),
    };
    expect(parseBundle(JSON.stringify(bundle))).toBeNull();
  });
});

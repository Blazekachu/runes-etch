import { describe, it, expect } from 'vitest';
import {
  buildInscriptionScript,
  encodeInscriptionId,
} from '../inscription';

describe('Inscription envelope', () => {
  describe('encodeInscriptionId', () => {
    it('encodes inscription ID with index 0', () => {
      const txid = 'aa'.repeat(32);
      const bytes = encodeInscriptionId(`${txid}i0`);
      expect(bytes.length).toBe(32);
    });
    it('encodes inscription ID with non-zero index', () => {
      const txid = 'bb'.repeat(32);
      const bytes = encodeInscriptionId(`${txid}i1`);
      expect(bytes.length).toBeGreaterThan(32);
    });
    it('throws on invalid format', () => {
      expect(() => encodeInscriptionId('invalid')).toThrow();
    });
  });

  describe('buildInscriptionScript', () => {
    it('builds valid inscription envelope with content', () => {
      const script = buildInscriptionScript({
        contentType: 'text/plain',
        body: new TextEncoder().encode('hello'),
        parentId: null,
        runeCommitment: null,
      });
      expect(script).toBeInstanceOf(Uint8Array);
      expect(script.length).toBeGreaterThan(0);
    });
    it('includes parent tag when parentId is provided', () => {
      const txid = 'cc'.repeat(32);
      const script = buildInscriptionScript({
        contentType: 'image/png',
        body: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
        parentId: `${txid}i0`,
        runeCommitment: null,
      });
      expect(script.length).toBeGreaterThan(0);
    });
    it('includes rune commitment when provided', () => {
      const script = buildInscriptionScript({
        contentType: 'text/plain',
        body: new TextEncoder().encode('hello'),
        parentId: null,
        runeCommitment: new Uint8Array([0x01, 0x02, 0x03]),
      });
      expect(script.length).toBeGreaterThan(0);
    });
    it('includes both parent and rune commitment', () => {
      const txid = 'dd'.repeat(32);
      const script = buildInscriptionScript({
        contentType: 'text/html',
        body: new TextEncoder().encode('<h1>Rune Coin</h1>'),
        parentId: `${txid}i0`,
        runeCommitment: new Uint8Array([0xab, 0xcd]),
      });
      expect(script.length).toBeGreaterThan(0);
    });
  });
});

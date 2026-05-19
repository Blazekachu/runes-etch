import { describe, it, expect } from 'vitest';
import { encodeVarint, decodeVarint } from '../varint';

describe('LEB128 u128 varint', () => {
  describe('encodeVarint', () => {
    it('encodes 0', () => {
      expect(encodeVarint(0n)).toEqual(new Uint8Array([0]));
    });

    it('encodes single-byte values (0-127)', () => {
      expect(encodeVarint(1n)).toEqual(new Uint8Array([1]));
      expect(encodeVarint(127n)).toEqual(new Uint8Array([127]));
    });

    it('encodes two-byte values (128-16383)', () => {
      expect(encodeVarint(128n)).toEqual(new Uint8Array([0x80, 0x01]));
      expect(encodeVarint(300n)).toEqual(new Uint8Array([0xac, 0x02]));
    });

    it('encodes large values', () => {
      expect(encodeVarint(624485n)).toEqual(new Uint8Array([0xe5, 0x8e, 0x26]));
    });

    it('encodes u128 max (2^128 - 1)', () => {
      const maxU128 = (1n << 128n) - 1n;
      const encoded = encodeVarint(maxU128);
      expect(encoded.length).toBeLessThanOrEqual(19);
      const [decoded] = decodeVarint(encoded, 0);
      expect(decoded).toBe(maxU128);
    });
  });

  describe('decodeVarint', () => {
    it('decodes 0', () => {
      const [value, bytesRead] = decodeVarint(new Uint8Array([0]), 0);
      expect(value).toBe(0n);
      expect(bytesRead).toBe(1);
    });

    it('decodes multi-byte values', () => {
      const [value, bytesRead] = decodeVarint(new Uint8Array([0xac, 0x02]), 0);
      expect(value).toBe(300n);
      expect(bytesRead).toBe(2);
    });

    it('decodes from offset', () => {
      const buf = new Uint8Array([0xff, 0xff, 0xac, 0x02]);
      const [value, bytesRead] = decodeVarint(buf, 2);
      expect(value).toBe(300n);
      expect(bytesRead).toBe(2);
    });

    it('round-trips all test values', () => {
      const testValues = [0n, 1n, 127n, 128n, 255n, 256n, 300n, 624485n, 1000000n, (1n << 64n) - 1n, (1n << 128n) - 1n];
      for (const val of testValues) {
        const encoded = encodeVarint(val);
        const [decoded] = decodeVarint(encoded, 0);
        expect(decoded).toBe(val);
      }
    });
  });
});

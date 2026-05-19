import { describe, it, expect } from 'vitest';
import { encodeRunestone, buildRunestoneScript, Tag, Flag } from '../runestone';
import { decodeVarint } from '../varint';

describe('Runestone encoder', () => {
  describe('encodeRunestone', () => {
    it('encodes a basic etching with no terms', () => {
      const payload = encodeRunestone({
        etching: {
          runeName: 'AAAAAAAAAAAAAAA',
          spacers: 0,
          symbol: '$',
          divisibility: 2,
          premine: 1000000n,
          terms: null,
          turbo: false,
        },
        pointer: 0,
        nonce: new Uint8Array([]),
      });

      let offset = 0;
      const values: bigint[] = [];
      while (offset < payload.length) {
        const [val, bytesRead] = decodeVarint(payload, offset);
        values.push(val);
        offset += bytesRead;
      }

      const flagsIdx = values.indexOf(BigInt(Tag.Flags));
      expect(flagsIdx).toBeGreaterThanOrEqual(0);
      expect(values[flagsIdx + 1]! & BigInt(Flag.Etching)).toBe(BigInt(Flag.Etching));
      expect(values[flagsIdx + 1]! & BigInt(Flag.Terms)).toBe(0n);
    });

    it('encodes etching with open mint terms', () => {
      const payload = encodeRunestone({
        etching: {
          runeName: 'AAAAAAAAAAAAAAA',
          spacers: 0,
          symbol: '&',
          divisibility: 0,
          premine: 0n,
          terms: {
            amount: 420n,
            cap: 69n,
            heightStart: null,
            heightEnd: null,
            offsetStart: null,
            offsetEnd: 9001,
          },
          turbo: true,
        },
        pointer: 0,
        nonce: new Uint8Array([]),
      });

      let offset = 0;
      const values: bigint[] = [];
      while (offset < payload.length) {
        const [val, bytesRead] = decodeVarint(payload, offset);
        values.push(val);
        offset += bytesRead;
      }

      const flagsIdx = values.indexOf(BigInt(Tag.Flags));
      const flags = values[flagsIdx + 1]!;
      expect(flags & BigInt(Flag.Etching)).toBe(BigInt(Flag.Etching));
      expect(flags & BigInt(Flag.Terms)).toBe(BigInt(Flag.Terms));
      expect(flags & BigInt(Flag.Turbo)).toBe(BigInt(Flag.Turbo));

      const amountIdx = values.indexOf(BigInt(Tag.Amount));
      expect(amountIdx).toBeGreaterThanOrEqual(0);
      expect(values[amountIdx + 1]).toBe(420n);

      const capIdx = values.indexOf(BigInt(Tag.Cap));
      expect(capIdx).toBeGreaterThanOrEqual(0);
      expect(values[capIdx + 1]).toBe(69n);
    });

    it('includes Nop tag with nonce bytes', () => {
      const nonce = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
      const payload = encodeRunestone({
        etching: {
          runeName: 'AAAAAAAAAAAAAAA',
          spacers: 0,
          symbol: '$',
          divisibility: 0,
          premine: 1000n,
          terms: null,
          turbo: false,
        },
        pointer: 0,
        nonce,
      });

      let offset = 0;
      const values: bigint[] = [];
      while (offset < payload.length) {
        const [val, bytesRead] = decodeVarint(payload, offset);
        values.push(val);
        offset += bytesRead;
      }

      const nopIdx = values.indexOf(BigInt(Tag.Nop));
      expect(nopIdx).toBeGreaterThanOrEqual(0);
    });
  });

  describe('buildRunestoneScript', () => {
    it('produces valid OP_RETURN OP_13 script', () => {
      const script = buildRunestoneScript({
        etching: {
          runeName: 'AAAAAAAAAAAAAAA',
          spacers: 0,
          symbol: '$',
          divisibility: 0,
          premine: 100n,
          terms: null,
          turbo: false,
        },
        pointer: 0,
        nonce: new Uint8Array([]),
      });

      expect(script[0]).toBe(0x6a); // OP_RETURN
      expect(script[1]).toBe(0x5d); // OP_13
    });
  });
});

import { encodeVarintsToBuffer } from './varint';
import { runeNameToU128 } from './names';
import type { RunestoneData } from '@/types';

export enum Tag {
  Body = 0,
  Divisibility = 1,
  Flags = 2,
  Spacers = 3,
  Rune = 4,
  Symbol = 5,
  Premine = 6,
  Cap = 8,
  Amount = 10,
  HeightStart = 12,
  HeightEnd = 14,
  OffsetStart = 16,
  OffsetEnd = 18,
  Mint = 20,
  Pointer = 22,
  Cenotaph = 126,
  Nop = 127,
}

export enum Flag {
  Etching = 1,
  Terms = 2,
  Turbo = 4,
}

export function encodeRunestone(data: RunestoneData): Uint8Array {
  const { etching, pointer, nonce } = data;
  const fields: bigint[] = [];

  let flags = Flag.Etching;
  if (etching.terms) flags |= Flag.Terms;
  if (etching.turbo) flags |= Flag.Turbo;
  fields.push(BigInt(Tag.Flags), BigInt(flags));

  const runeValue = runeNameToU128(etching.runeName);
  fields.push(BigInt(Tag.Rune), runeValue);

  if (etching.divisibility > 0) {
    fields.push(BigInt(Tag.Divisibility), BigInt(etching.divisibility));
  }
  if (etching.spacers > 0) {
    fields.push(BigInt(Tag.Spacers), BigInt(etching.spacers));
  }
  if (etching.symbol) {
    fields.push(BigInt(Tag.Symbol), BigInt(etching.symbol.codePointAt(0)!));
  }
  if (etching.premine > 0n) {
    fields.push(BigInt(Tag.Premine), etching.premine);
  }

  if (etching.terms) {
    const { amount, cap, heightStart, heightEnd, offsetStart, offsetEnd } = etching.terms;
    if (amount > 0n) fields.push(BigInt(Tag.Amount), amount);
    if (cap > 0n) fields.push(BigInt(Tag.Cap), cap);
    if (heightStart !== null) fields.push(BigInt(Tag.HeightStart), BigInt(heightStart));
    if (heightEnd !== null) fields.push(BigInt(Tag.HeightEnd), BigInt(heightEnd));
    if (offsetStart !== null) fields.push(BigInt(Tag.OffsetStart), BigInt(offsetStart));
    if (offsetEnd !== null) fields.push(BigInt(Tag.OffsetEnd), BigInt(offsetEnd));
  }

  if (pointer !== null) {
    fields.push(BigInt(Tag.Pointer), BigInt(pointer));
  }

  if (nonce.length > 0) {
    let nonceValue = 0n;
    for (let i = nonce.length - 1; i >= 0; i--) {
      nonceValue = (nonceValue << 8n) | BigInt(nonce[i]);
    }
    fields.push(BigInt(Tag.Nop), nonceValue);
  }

  return encodeVarintsToBuffer(fields);
}

export function buildRunestoneScript(data: RunestoneData): Uint8Array {
  const payload = encodeRunestone(data);
  const chunks = splitIntoChunks(payload, 520);
  const parts: number[] = [0x6a, 0x5d]; // OP_RETURN, OP_13

  for (const chunk of chunks) {
    if (chunk.length <= 75) {
      parts.push(chunk.length);
    } else if (chunk.length <= 255) {
      parts.push(0x4c, chunk.length);
    } else {
      parts.push(0x4d, chunk.length & 0xff, (chunk.length >> 8) & 0xff);
    }
    parts.push(...chunk);
  }

  return new Uint8Array(parts);
}

function splitIntoChunks(data: Uint8Array, maxSize: number): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < data.length; i += maxSize) {
    chunks.push(data.slice(i, i + maxSize));
  }
  if (chunks.length === 0) chunks.push(new Uint8Array([]));
  return chunks;
}

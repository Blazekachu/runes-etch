const MAX_U128 = (1n << 128n) - 1n;

export function encodeVarint(value: bigint): Uint8Array {
  if (value < 0n || value > MAX_U128) {
    throw new Error(`Value out of u128 range: ${value}`);
  }

  const bytes: number[] = [];
  let v = value;

  while (v > 127n) {
    bytes.push(Number(v & 0x7fn) | 0x80);
    v >>= 7n;
  }
  bytes.push(Number(v & 0x7fn));

  return new Uint8Array(bytes);
}

export function decodeVarint(
  buffer: Uint8Array,
  offset: number
): [bigint, number] {
  let value = 0n;
  let shift = 0n;
  let bytesRead = 0;

  for (let i = offset; i < buffer.length; i++) {
    const byte = buffer[i];
    bytesRead++;

    if (bytesRead > 19) {
      throw new Error('Varint too long (exceeds u128)');
    }

    value |= BigInt(byte & 0x7f) << shift;

    if ((byte & 0x80) === 0) {
      if (value > MAX_U128) throw new Error('Varint value exceeds u128 range');
      return [value, bytesRead];
    }

    shift += 7n;
  }

  throw new Error('Unexpected end of varint');
}

export function encodeVarintsToBuffer(values: bigint[]): Uint8Array {
  const encoded = values.map(encodeVarint);
  const totalLength = encoded.reduce((sum, arr) => sum + arr.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const arr of encoded) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}

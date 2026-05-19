// Vanity TXID Grinder — Web Worker
// No external imports: must be self-contained for use as a Worker module.

// ---------------------------------------------------------------------------
// Inline synchronous SHA-256 (FIPS 180-4)
// ---------------------------------------------------------------------------

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5,
  0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
  0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
  0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
  0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

// Reusable buffers to avoid allocation in the hot loop
const _w = new Uint32Array(64);
const _state = new Uint32Array(8);

function sha256(data: Uint8Array): Uint8Array {
  // Pre-processing: padding
  const len = data.length;
  const bitLen = len * 8;
  // padded length: next multiple of 64 that fits msg + 1 byte (0x80) + 8 bytes (length)
  const padLen = ((len + 9 + 63) & ~63);
  const padded = new Uint8Array(padLen);
  padded.set(data);
  padded[len] = 0x80;
  // Write 64-bit big-endian bit length at the end
  // JavaScript bitwise ops are 32-bit so handle high word carefully
  const highBits = Math.floor(bitLen / 0x100000000);
  const lowBits = bitLen >>> 0;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padLen - 8, highBits, false);
  dv.setUint32(padLen - 4, lowBits, false);

  // Initial hash values (first 32 bits of fractional parts of sqrt of first 8 primes)
  _state[0] = 0x6a09e667;
  _state[1] = 0xbb67ae85;
  _state[2] = 0x3c6ef372;
  _state[3] = 0xa54ff53a;
  _state[4] = 0x510e527f;
  _state[5] = 0x9b05688c;
  _state[6] = 0x1f83d9ab;
  _state[7] = 0x5be0cd19;

  // Process each 512-bit (64-byte) block
  for (let offset = 0; offset < padLen; offset += 64) {
    // Prepare message schedule
    for (let i = 0; i < 16; i++) {
      _w[i] = dv.getUint32(offset + i * 4, false);
    }
    for (let i = 16; i < 64; i++) {
      const s0 = rotr32(_w[i - 15], 7) ^ rotr32(_w[i - 15], 18) ^ (_w[i - 15] >>> 3);
      const s1 = rotr32(_w[i - 2], 17) ^ rotr32(_w[i - 2], 19) ^ (_w[i - 2] >>> 10);
      _w[i] = (_w[i - 16] + s0 + _w[i - 7] + s1) >>> 0;
    }

    let a = _state[0];
    let b = _state[1];
    let c = _state[2];
    let d = _state[3];
    let e = _state[4];
    let f = _state[5];
    let g = _state[6];
    let h = _state[7];

    for (let i = 0; i < 64; i++) {
      const S1 = rotr32(e, 6) ^ rotr32(e, 11) ^ rotr32(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + K[i] + _w[i]) >>> 0;
      const S0 = rotr32(a, 2) ^ rotr32(a, 13) ^ rotr32(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    _state[0] = (_state[0] + a) >>> 0;
    _state[1] = (_state[1] + b) >>> 0;
    _state[2] = (_state[2] + c) >>> 0;
    _state[3] = (_state[3] + d) >>> 0;
    _state[4] = (_state[4] + e) >>> 0;
    _state[5] = (_state[5] + f) >>> 0;
    _state[6] = (_state[6] + g) >>> 0;
    _state[7] = (_state[7] + h) >>> 0;
  }

  const digest = new Uint8Array(32);
  const dvOut = new DataView(digest.buffer);
  for (let i = 0; i < 8; i++) {
    dvOut.setUint32(i * 4, _state[i], false);
  }
  return digest;
}

function rotr32(x: number, n: number): number {
  return ((x >>> n) | (x << (32 - n))) >>> 0;
}

function doubleSha256(data: Uint8Array): Uint8Array {
  return sha256(sha256(data));
}

// ---------------------------------------------------------------------------
// Hex helpers
// ---------------------------------------------------------------------------

// Pre-build a lookup table for fast byte→hex conversion
const HEX_CHARS = '0123456789abcdef';
const HEX_TABLE = new Array(256);
for (let i = 0; i < 256; i++) {
  HEX_TABLE[i] = HEX_CHARS[(i >>> 4) & 0xf] + HEX_CHARS[i & 0xf];
}

function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += HEX_TABLE[bytes[i]];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Message types
// ---------------------------------------------------------------------------

interface GrindRequest {
  type: 'start';
  txTemplate: Uint8Array;
  nonceOffset: number;
  nonceLength: number;
  prefix: string;
  suffix: string;
  batchSize: number;
}

interface GrindProgress {
  type: 'progress';
  attempts: number;
  speed: number;
  bestMatch: string;
}

interface GrindResult {
  type: 'found';
  nonce: Uint8Array;
  txid: string;
  attempts: number;
}

// ---------------------------------------------------------------------------
// Worker message handler
// ---------------------------------------------------------------------------

self.onmessage = (event: MessageEvent<GrindRequest>) => {
  const { type, txTemplate, nonceOffset, nonceLength, prefix, suffix, batchSize } = event.data;

  if (type !== 'start') return;

  // Work on a mutable copy of the template
  const tx = new Uint8Array(txTemplate);
  const nonce = new Uint8Array(nonceLength);

  let totalAttempts = 0;
  let bestMatch = '';
  let lastProgressTime = Date.now();
  let attemptsAtLastReport = 0;

  // Reversed hash buffer (reused each iteration to avoid allocation)
  const reversed = new Uint8Array(32);

  function grindBatch() {
    // L2: Use setTimeout between batches so the worker event loop can process terminate() signals
    for (let i = 0; i < batchSize; i++) {
      // Write fresh random nonce into the template
      crypto.getRandomValues(nonce);
      tx.set(nonce, nonceOffset);

      // Compute TXID: double-SHA256, then reverse for display
      const hash = doubleSha256(tx);
      for (let j = 0; j < 32; j++) {
        reversed[j] = hash[31 - j];
      }
      const txid = bytesToHex(reversed);

      totalAttempts++;

      // Track best partial match for UI feedback
      let matchLen = 0;
      const maxCheck = Math.max(prefix.length, suffix.length);
      for (let k = 0; k < maxCheck; k++) {
        if (k < prefix.length && txid[k] === prefix[k]) matchLen++;
        if (k < suffix.length && txid[63 - k] === suffix[suffix.length - 1 - k]) matchLen++;
      }
      if (matchLen > bestMatch.length || bestMatch === '') {
        bestMatch = txid;
      }

      // Check for full match
      if (txid.startsWith(prefix) && txid.endsWith(suffix)) {
        const foundNonce = new Uint8Array(nonce);
        const result: GrindResult = {
          type: 'found',
          nonce: foundNonce,
          txid,
          attempts: totalAttempts,
        };
        self.postMessage(result);
        return;
      }
    }

    // Report progress after each batch
    const now = Date.now();
    const elapsed = (now - lastProgressTime) / 1000;
    const speed = elapsed > 0 ? Math.round((totalAttempts - attemptsAtLastReport) / elapsed) : 0;

    const progress: GrindProgress = {
      type: 'progress',
      attempts: totalAttempts,
      speed,
      bestMatch,
    };
    self.postMessage(progress);

    lastProgressTime = now;
    attemptsAtLastReport = totalAttempts;

    // Yield to event loop, then continue
    setTimeout(grindBatch, 0);
  }

  grindBatch();
};

/**
 * Inscription envelope builder for tapscript witness data.
 * Reference: github.com/ordinals/ord — src/inscription.rs
 *
 * Envelope format inside tapscript:
 *   <pubkey> OP_CHECKSIG
 *   OP_FALSE OP_IF
 *     OP_PUSH "ord"
 *     [OP_PUSH <tag> OP_PUSH <value>]...
 *     OP_PUSH 0 (body tag)
 *     OP_PUSH <body_chunk_1>
 *   OP_ENDIF
 *
 * Tags: 1=content-type, 3=parent, 13=rune commitment, 0=body
 */

const OP_FALSE = 0x00;
const OP_IF = 0x63;
const OP_ENDIF = 0x68;
const OP_CHECKSIG = 0xac;
const OP_PUSHDATA1 = 0x4c;
const OP_PUSHDATA2 = 0x4d;
const OP_PUSHDATA4 = 0x4e;
const MAX_PUSH_SIZE = 520;

const TAG_BODY = 0;
const TAG_CONTENT_TYPE = 1;
const TAG_PARENT = 3;
const TAG_DELEGATE = 11;
const TAG_RUNE = 13;

/** Hex string → Uint8Array, reversed (little-endian txid). */
function hexToUint8ArrayReversed(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  bytes.reverse();
  return bytes;
}

/** UTF-8 string → Uint8Array. */
function strToUint8Array(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

/**
 * Encodes a push-data length prefix per Bitcoin script rules (BIP62.3 minimal push).
 * Returns the opcode byte(s) for pushing `len` bytes.
 */
function pushDataPrefix(len: number): Uint8Array {
  if (len < OP_PUSHDATA1) {
    // direct push opcode (0x01..0x4b)
    return new Uint8Array([len]);
  } else if (len <= 0xff) {
    return new Uint8Array([OP_PUSHDATA1, len]);
  } else if (len <= 0xffff) {
    return new Uint8Array([OP_PUSHDATA2, len & 0xff, (len >> 8) & 0xff]);
  } else {
    return new Uint8Array([
      OP_PUSHDATA4,
      len & 0xff,
      (len >> 8) & 0xff,
      (len >> 16) & 0xff,
      (len >> 24) & 0xff,
    ]);
  }
}

/**
 * Compiles an array of opcodes (numbers) and data chunks (Uint8Arrays) into a
 * Bitcoin script byte sequence. Implements BIP62.3 minimal-push policy: a
 * single-byte chunk whose value is 0x01–0x10 or 0x81 is emitted as the
 * corresponding OP_1–OP_16 / OP_1NEGATE opcode instead of a data push.
 *
 * This is a self-contained implementation that avoids bitcoinjs-lib's
 * `script.compile()`, which uses valibot `instanceof Uint8Array` validation
 * that breaks under jsdom's separate global realm.
 */
function compileScript(chunks: (number | Uint8Array)[]): Uint8Array {
  // Compute total byte length first
  let size = 0;
  for (const chunk of chunks) {
    if (typeof chunk === 'number') {
      size += 1;
    } else {
      // BIP62.3: 1-byte chunk that maps to OP_0, OP_1–OP_16, or OP_1NEGATE
      if (chunk.length === 1) {
        const b = chunk[0];
        if (b === 0x00 || (b >= 0x01 && b <= 0x10) || b === 0x81) {
          size += 1;
          continue;
        }
      }
      if (chunk.length === 0) {
        // OP_0
        size += 1;
        continue;
      }
      size += pushDataPrefix(chunk.length).length + chunk.length;
    }
  }

  const out = new Uint8Array(size);
  let offset = 0;

  for (const chunk of chunks) {
    if (typeof chunk === 'number') {
      out[offset++] = chunk;
    } else {
      // BIP62.3 minimal push
      if (chunk.length === 0) {
        out[offset++] = 0x00; // OP_0
        continue;
      }
      if (chunk.length === 1) {
        const b = chunk[0];
        if (b === 0x00) { out[offset++] = 0x00; continue; }          // OP_0
        if (b >= 0x01 && b <= 0x10) { out[offset++] = 0x50 + b; continue; } // OP_1–OP_16
        if (b === 0x81) { out[offset++] = 0x4f; continue; }           // OP_1NEGATE
      }
      const prefix = pushDataPrefix(chunk.length);
      out.set(prefix, offset);
      offset += prefix.length;
      out.set(chunk, offset);
      offset += chunk.length;
    }
  }

  return out;
}

export function encodeInscriptionId(inscriptionId: string): Uint8Array {
  const match = inscriptionId.match(/^([0-9a-f]{64})i(\d+)$/i);
  if (!match) throw new Error(`Invalid inscription ID format: ${inscriptionId}`);
  const txidHex = match[1];
  const index = parseInt(match[2], 10);
  const txidBytes = hexToUint8ArrayReversed(txidHex);
  if (index === 0) return txidBytes;
  const indexBytes: number[] = [];
  let idx = index;
  while (idx > 0) { indexBytes.push(idx & 0xff); idx >>= 8; }
  const result = new Uint8Array(32 + indexBytes.length);
  result.set(txidBytes, 0);
  result.set(new Uint8Array(indexBytes), 32);
  return result;
}

export interface InscriptionParams {
  contentType: string;
  body: Uint8Array;
  parentId: string | null;
  /** Delegate to an existing inscription instead of embedding content. */
  delegateId?: string | null;
  runeCommitment: Uint8Array | null;
}

export function buildInscriptionScript(params: InscriptionParams): Uint8Array {
  const { contentType, body, parentId, delegateId, runeCommitment } = params;
  const chunks: (number | Uint8Array)[] = [];

  chunks.push(OP_FALSE, OP_IF);
  chunks.push(strToUint8Array('ord'));

  // Content-type tag (skip when using delegate — delegate provides its own)
  if (!delegateId && contentType) {
    chunks.push(new Uint8Array([TAG_CONTENT_TYPE]));
    chunks.push(strToUint8Array(contentType));
  }

  // Parent tag (optional)
  if (parentId) {
    const parentBytes = encodeInscriptionId(parentId);
    chunks.push(new Uint8Array([TAG_PARENT]));
    chunks.push(parentBytes);
  }

  // Delegate tag — points to an existing inscription for content
  if (delegateId) {
    const delegateBytes = encodeInscriptionId(delegateId);
    chunks.push(new Uint8Array([TAG_DELEGATE]));
    chunks.push(delegateBytes);
  }

  // Rune commitment tag (optional)
  if (runeCommitment && runeCommitment.length > 0) {
    chunks.push(new Uint8Array([TAG_RUNE]));
    chunks.push(runeCommitment);
  }

  // Body tag + content (skip when using delegate — body is empty)
  if (!delegateId && body.length > 0) {
    chunks.push(new Uint8Array([TAG_BODY]));
    for (let i = 0; i < body.length; i += MAX_PUSH_SIZE) {
      chunks.push(body.slice(i, i + MAX_PUSH_SIZE));
    }
  }

  chunks.push(OP_ENDIF);

  return compileScript(chunks);
}

/**
 * Bare commitment script for no-inscription mode.
 * Just the rune name commitment in an unexecuted OP_IF branch.
 * No "ord" envelope, no content, no parent.
 */
export function buildBareCommitmentScript(
  runeCommitment: Uint8Array
): Uint8Array {
  return compileScript([
    OP_FALSE,
    OP_IF,
    runeCommitment,
    OP_ENDIF,
  ]);
}

export function buildTapscript(
  internalPubkey: Uint8Array,
  inscriptionParams: InscriptionParams
): Uint8Array {
  const inscriptionEnvelope = buildInscriptionScript(inscriptionParams);
  // The inscription envelope must be inlined as raw script opcodes, NOT data-pushed.
  // compileScript would wrap Uint8Array in a data push prefix — wrong for executable opcodes.
  // Instead: compile the pubkey + OP_CHECKSIG prefix, then concatenate raw envelope bytes.
  const prefix = compileScript([internalPubkey, OP_CHECKSIG]);
  const result = new Uint8Array(prefix.length + inscriptionEnvelope.length);
  result.set(prefix, 0);
  result.set(inscriptionEnvelope, prefix.length);
  return result;
}

/**
 * Build tapscript for bare commitment (no inscription).
 */
export function buildBareTapscript(
  internalPubkey: Uint8Array,
  runeCommitment: Uint8Array
): Uint8Array {
  const bareScript = buildBareCommitmentScript(runeCommitment);
  const prefix = compileScript([internalPubkey, OP_CHECKSIG]);
  const result = new Uint8Array(prefix.length + bareScript.length);
  result.set(prefix, 0);
  result.set(bareScript, prefix.length);
  return result;
}

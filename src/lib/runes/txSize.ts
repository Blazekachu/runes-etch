/**
 * Generic Bitcoin transaction vsize estimator (BIP-141 witness discount).
 * Used by the UTXO cost preview to size the commit + reveal transactions.
 * Network-agnostic and not tied to any etch mode.
 *
 * (Extracted from the former quickEtch.ts when single-TX "quick" etch was removed —
 * the estimator itself was always generic; only its name carried "QuickEtch".)
 */
export type EstimatorInput = { type: 'p2wpkh' } | { type: 'p2tr' };
export type EstimatorOutput =
  | { type: 'p2wpkh' }
  | { type: 'p2tr' }
  | { type: 'op_return'; scriptByteLen: number };

// vsize contributions (BIP-141 witness discount: weight / 4):
//   tx overhead   = 10.5 vB (4 version + 1+1 in/out varints + 4 locktime + 0.5 marker/flag)
//   p2wpkh input  = 68 vB   (41-byte outpoint*4 weight + ~108 weight witness)
//   p2tr input    = 57.5 vB (41-byte outpoint*4 weight + 66 weight witness, key-path)
//   p2wpkh output = 31 vB   (8 value + 1 scriptlen + 22 script)
//   p2tr output   = 43 vB   (8 value + 1 scriptlen + 34 script)
//   op_return out = 9 + scriptByteLen vB (8 value + 1 scriptlen varint + script)
const TX_OVERHEAD_VB = 10.5;
const P2WPKH_IN_VB = 68;
const P2TR_IN_VB = 57.5;
const P2WPKH_OUT_VB = 31;
const P2TR_OUT_VB = 43;
const OP_RETURN_OUT_BASE_VB = 9; // + scriptByteLen

export function estimateTxVBytes(
  inputs: EstimatorInput[],
  outputs: EstimatorOutput[],
): number {
  let vb = TX_OVERHEAD_VB;
  for (const i of inputs) vb += i.type === 'p2tr' ? P2TR_IN_VB : P2WPKH_IN_VB;
  for (const o of outputs) {
    if (o.type === 'p2tr') vb += P2TR_OUT_VB;
    else if (o.type === 'p2wpkh') vb += P2WPKH_OUT_VB;
    else vb += OP_RETURN_OUT_BASE_VB + o.scriptByteLen;
  }
  return Math.ceil(vb);
}

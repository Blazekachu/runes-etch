/**
 * Generic Bitcoin transaction vsize estimator (BIP-141 witness discount).
 * Used by the UTXO cost preview to size the commit + reveal transactions.
 * Network-agnostic and not tied to any etch mode.
 */
export type EstimatorInput =
  | { type: 'p2wpkh' }
  | { type: 'p2tr' }
  | { type: 'p2sh-p2wpkh' };
export type EstimatorOutput =
  | { type: 'p2wpkh' }
  | { type: 'p2tr' }
  | { type: 'p2sh-p2wpkh' }
  | { type: 'op_return'; scriptByteLen: number };

// vsize contributions (BIP-141 witness discount: weight / 4):
//   tx overhead        = 10.5 vB
//   p2wpkh input       = 68 vB
//   p2sh-p2wpkh input  = 91 vB
//   p2tr input         = 57.5 vB (key-path)
//   p2wpkh output      = 31 vB
//   p2sh output        = 32 vB
//   p2tr output        = 43 vB
//   op_return out      = 9 + scriptByteLen vB
const TX_OVERHEAD_VB = 10.5;
const P2WPKH_IN_VB = 68;
const P2SH_P2WPKH_IN_VB = 91;
const P2TR_IN_VB = 57.5;
const P2WPKH_OUT_VB = 31;
const P2SH_OUT_VB = 32;
const P2TR_OUT_VB = 43;
const OP_RETURN_OUT_BASE_VB = 9; // + scriptByteLen

export function estimateTxVBytes(
  inputs: EstimatorInput[],
  outputs: EstimatorOutput[],
): number {
  let vb = TX_OVERHEAD_VB;
  for (const i of inputs) {
    if (i.type === 'p2tr') vb += P2TR_IN_VB;
    else if (i.type === 'p2sh-p2wpkh') vb += P2SH_P2WPKH_IN_VB;
    else vb += P2WPKH_IN_VB;
  }
  for (const o of outputs) {
    if (o.type === 'p2tr') vb += P2TR_OUT_VB;
    else if (o.type === 'p2wpkh') vb += P2WPKH_OUT_VB;
    else if (o.type === 'p2sh-p2wpkh') vb += P2SH_OUT_VB;
    else vb += OP_RETURN_OUT_BASE_VB + o.scriptByteLen;
  }
  return Math.ceil(vb);
}

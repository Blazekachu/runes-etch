import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';
import { buildTapscript, buildBareTapscript } from './inscription';
import { runeNameToCommitmentBytes } from './names';
import type { InscriptionFile, ParentInscription, Utxo } from '@/types';

bitcoin.initEccLib(ecc);

// Taptree is not re-exported from the bitcoinjs-lib main entry point.
// Mirror the definition from bitcoinjs-lib/src/types.ts.
type Tapleaf = { output: Buffer; version?: number };
type Taptree = [Taptree | Tapleaf, Taptree | Tapleaf] | Tapleaf;

const DUST_LIMIT = 546n;

export interface FundingUtxo extends Utxo {
  address: string;
}

export interface CommitTxParams {
  runeName: string;
  inscriptionFile: InscriptionFile | null;  // null = bare commitment mode (unless delegateId)
  delegateId: string | null;                // delegate to existing inscription
  parentInscription: ParentInscription | null;
  fundingUtxos: FundingUtxo[];
  feeRate: number;
  changeAddress: string;
  internalPubkey: Buffer;
  network?: bitcoin.Network;
}

export interface CommitTxResult {
  psbt: bitcoin.Psbt;
  commitAddress: string;
  commitOutputValue: number;
  commitOutputIndex: number;
  tapscript: Uint8Array;
  tapLeafHash: Buffer;
  controlBlock: Buffer;
  scriptTree: Taptree;
  dustChange: number; // sats lost to miners if change < dust limit (0 if no loss)
}

export function buildCommitTx(params: CommitTxParams): CommitTxResult {
  const {
    runeName, inscriptionFile, delegateId, parentInscription, fundingUtxos,
    feeRate, changeAddress, internalPubkey,
    network = bitcoin.networks.bitcoin,
  } = params;

  const runeCommitment = runeNameToCommitmentBytes(runeName);

  // Build tapscript based on mode:
  // - inscriptionFile: full inscription with embedded content
  // - delegateId (no file): inscription envelope with delegate pointer (tiny)
  // - neither: bare commitment (no inscription)
  let tapscript: Uint8Array;
  if (inscriptionFile || delegateId) {
    tapscript = buildTapscript(internalPubkey, {
      contentType: inscriptionFile?.contentType ?? '',
      body: inscriptionFile?.body ?? new Uint8Array(0),
      parentId: parentInscription?.inscriptionId ?? null,
      delegateId,
      runeCommitment,
    });
  } else {
    tapscript = buildBareTapscript(internalPubkey, runeCommitment);
  }

  const tapscriptBuf = Buffer.from(tapscript);
  const scriptTree: Taptree = { output: tapscriptBuf };
  const { address: commitAddress, output: commitOutput } = bitcoin.payments.p2tr({
    internalPubkey,
    scriptTree,
    network,
  });

  if (!commitAddress || !commitOutput) throw new Error('Failed to derive commit P2TR address');

  const hasInscription = !!inscriptionFile || !!delegateId;
  const contentSize = inscriptionFile?.body.length ?? 0;
  // Always include a rune receiver output — runes need a non-OP_RETURN destination.
  // In inscription mode: this is the inscription output. In no-inscription: dedicated dust output.
  const revealVBytes = estimateRevealVBytes(contentSize, true, !!parentInscription);
  const revealFee = BigInt(Math.ceil(revealVBytes * feeRate));
  const runeOutputValue = DUST_LIMIT; // rune receiver always present
  const parentReturnValue = parentInscription ? DUST_LIMIT : 0n;
  const commitOutputValue = revealFee + runeOutputValue + parentReturnValue + DUST_LIMIT;

  const psbt = new bitcoin.Psbt({ network });

  let totalInput = 0n;
  for (const utxo of fundingUtxos) {
    const isTaproot = utxo.address.startsWith('bc1p') || utxo.address.startsWith('tb1p');
    const input: Record<string, unknown> = {
      hash: utxo.txid,
      index: utxo.vout,
      witnessUtxo: {
        script: bitcoin.address.toOutputScript(utxo.address, network),
        value: BigInt(utxo.value),
      },
    };
    // C1: Only set tapInternalKey for P2TR inputs. P2WPKH inputs don't use it.
    if (isTaproot) input.tapInternalKey = internalPubkey;
    psbt.addInput(input as unknown as Parameters<typeof psbt.addInput>[0]);
    totalInput += BigInt(utxo.value);
  }

  psbt.addOutput({ address: commitAddress, value: commitOutputValue });
  const commitOutputIndex = 0;

  // M3: Count P2WPKH vs P2TR inputs for accurate size estimate
  const numTaprootInputs = fundingUtxos.filter((u) => u.address.startsWith('bc1p') || u.address.startsWith('tb1p')).length;
  const numSegwitInputs = fundingUtxos.length - numTaprootInputs;

  // Estimate with 2 outputs first, then adjust if no change output
  let numOutputs = 2;
  let commitVBytes = estimateCommitVBytes(numTaprootInputs, numSegwitInputs, numOutputs);
  let commitFee = BigInt(Math.ceil(commitVBytes * feeRate));

  let changeValue = totalInput - commitOutputValue - commitFee;
  if (changeValue < 0n) {
    throw new Error(`Insufficient funds. Need ${commitOutputValue + commitFee} sats, have ${totalInput} sats.`);
  }
  if (changeValue >= DUST_LIMIT) {
    psbt.addOutput({ address: changeAddress, value: changeValue });
  } else {
    // No change output — re-estimate with 1 output for tighter fee
    numOutputs = 1;
    commitVBytes = estimateCommitVBytes(numTaprootInputs, numSegwitInputs, numOutputs);
    commitFee = BigInt(Math.ceil(commitVBytes * feeRate));
    changeValue = totalInput - commitOutputValue - commitFee;
  }

  // TapLeaf hash: tagged hash of (leaf_version || compact_size(script) || script)
  const tapLeafHash = Buffer.from(
    bitcoin.crypto.taggedHash(
      'TapLeaf',
      Buffer.concat([
        Buffer.from([0xc0]),
        serializeScriptWithCompactSize(tapscriptBuf),
      ]),
    ),
  );

  // Derive control block via the redeem script path
  const redeemPayment = bitcoin.payments.p2tr({
    internalPubkey,
    scriptTree,
    redeem: { output: tapscriptBuf, redeemVersion: 0xc0 },
    network,
  });

  const controlBlockWitness = redeemPayment.witness;
  const controlBlock = controlBlockWitness && controlBlockWitness.length > 0
    ? Buffer.from(controlBlockWitness[controlBlockWitness.length - 1])
    : Buffer.alloc(0);

  const dustChange = (changeValue > 0n && changeValue < DUST_LIMIT) ? Number(changeValue) : 0;

  return {
    psbt,
    commitAddress,
    commitOutputValue: Number(commitOutputValue),
    commitOutputIndex,
    tapscript,
    tapLeafHash,
    controlBlock,
    scriptTree,
    dustChange,
  };
}

/**
 * Encodes a script buffer with a compact-size (varint) length prefix,
 * as required by the TapLeaf tagged hash preimage.
 */
function serializeScriptWithCompactSize(script: Buffer): Buffer {
  const len = script.length;
  let prefix: Buffer;
  if (len < 0xfd) {
    prefix = Buffer.from([len]);
  } else if (len <= 0xffff) {
    prefix = Buffer.alloc(3);
    prefix[0] = 0xfd;
    prefix.writeUInt16LE(len, 1);
  } else {
    prefix = Buffer.alloc(5);
    prefix[0] = 0xfe;
    prefix.writeUInt32LE(len, 1);
  }
  return Buffer.concat([prefix, script]);
}

function estimateCommitVBytes(numTaprootInputs: number, numSegwitInputs: number, numOutputs: number): number {
  // M3: P2TR key-path ~57.5 vB, P2WPKH ~68 vB
  return Math.ceil(10.5 + numTaprootInputs * 57.5 + numSegwitInputs * 68 + numOutputs * 43);
}

function estimateRevealVBytes(contentSize: number, hasInscription: boolean, hasParent: boolean): number {
  const baseVBytes = 10.5;
  const commitInputVBytes = 57.5 + Math.ceil(contentSize / 4);
  const parentInputVBytes = hasParent ? 57.5 : 0;
  // Outputs: inscription (optional) + parent return (optional) + OP_RETURN + change
  const numOutputs = (hasInscription ? 1 : 0) + (hasParent ? 1 : 0) + 1 + 1;
  const outputVBytes = 43 * numOutputs;
  const opReturnVBytes = 50;
  return Math.ceil(baseVBytes + commitInputVBytes + parentInputVBytes + outputVBytes + opReturnVBytes);
}

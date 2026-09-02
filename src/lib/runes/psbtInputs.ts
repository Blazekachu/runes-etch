import * as bitcoin from 'bitcoinjs-lib';

export interface FundingUtxoInput {
  txid: string;
  vout: number;
  value: number;
  address: string;
}

export interface PsbtKeyMaterial {
  /** Ordinals / commit taproot internal key (32 bytes). */
  ordinalsInternalPubkey: Buffer;
  ordinalsAddress: string;
  paymentAddress: string;
  /** Payment wallet pubkey (33-byte compressed or 32-byte x-only). */
  paymentPublicKey?: Buffer;
}

function normalizePaymentPubkey(pubkey: Buffer): Buffer {
  if (pubkey.length === 33) return pubkey;
  if (pubkey.length === 32) return pubkey;
  throw new Error(`Invalid payment public key length: ${pubkey.length} bytes (expected 32 or 33)`);
}

function taprootInternalKeyForAddress(
  address: string,
  keys: PsbtKeyMaterial,
): Buffer {
  if (address === keys.ordinalsAddress) return keys.ordinalsInternalPubkey;
  if (address === keys.paymentAddress && keys.paymentPublicKey) {
    const compressed = keys.paymentPublicKey.length === 33
      ? keys.paymentPublicKey
      : Buffer.concat([Buffer.from([0x02]), keys.paymentPublicKey]);
    return compressed.subarray(1);
  }
  if (keys.paymentPublicKey) {
    const compressed = keys.paymentPublicKey.length === 33
      ? keys.paymentPublicKey
      : Buffer.concat([Buffer.from([0x02]), keys.paymentPublicKey]);
    return compressed.subarray(1);
  }
  return keys.ordinalsInternalPubkey;
}

/**
 * Build a PSBT input for a funding UTXO with the metadata wallets need to sign.
 * Supports native segwit (bc1q), nested segwit (3…/2…), and taproot (bc1p).
 */
export function buildFundingPsbtInput(
  utxo: FundingUtxoInput,
  network: bitcoin.Network,
  keys: PsbtKeyMaterial,
): Parameters<bitcoin.Psbt['addInput']>[0] {
  const address = utxo.address;
  const isTaproot = address.startsWith('bc1p') || address.startsWith('tb1p') || address.startsWith('bcrt1p');
  const isNestedSegwit = address.startsWith('3') || address.startsWith('2');
  const isNativeSegwit = address.startsWith('bc1q') || address.startsWith('tb1q') || address.startsWith('bcrt1q');
  const isLegacyP2pkh = address.startsWith('1') || address.startsWith('m') || address.startsWith('n');

  if (isLegacyP2pkh) {
    throw new Error(
      'Legacy P2PKH payment UTXOs are not supported. Send coins to your native segwit (bc1q/tb1q) address first.',
    );
  }

  if (isNestedSegwit) {
    if (!keys.paymentPublicKey) {
      throw new Error(
        'P2SH payment UTXO requires payment public key from wallet. Reconnect your wallet and try again.',
      );
    }
    const paymentPubkey = normalizePaymentPubkey(keys.paymentPublicKey);
    const p2wpkh = bitcoin.payments.p2wpkh({ pubkey: paymentPubkey, network });
    const p2sh = bitcoin.payments.p2sh({ redeem: p2wpkh, network });
    if (!p2sh.output || !p2wpkh.output) {
      throw new Error('Failed to derive P2SH redeem script for payment UTXO.');
    }
    return {
      hash: utxo.txid,
      index: utxo.vout,
      witnessUtxo: {
        script: p2sh.output,
        value: BigInt(utxo.value),
      },
      redeemScript: p2wpkh.output,
    };
  }

  const outputScript = bitcoin.address.toOutputScript(address, network);
  const input: Record<string, unknown> = {
    hash: utxo.txid,
    index: utxo.vout,
    witnessUtxo: {
      script: outputScript,
      value: BigInt(utxo.value),
    },
  };

  if (isTaproot) {
    input.tapInternalKey = taprootInternalKeyForAddress(address, keys);
  } else if (!isNativeSegwit) {
    throw new Error(`Unsupported funding address type: ${address.slice(0, 16)}…`);
  }

  return input as unknown as Parameters<bitcoin.Psbt['addInput']>[0];
}

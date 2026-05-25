import Wallet, { AddressPurpose, RpcErrorCode } from 'sats-connect';
import type { WalletState } from '@/types';

export type WalletProvider = 'sats-connect' | 'leather';

const PROVIDER_KEY = 'runes-etch-wallet-provider';

function loadProvider(): WalletProvider {
  if (typeof window === 'undefined') return 'sats-connect';
  const stored = localStorage.getItem(PROVIDER_KEY);
  return stored === 'leather' ? 'leather' : 'sats-connect';
}

let activeProvider: WalletProvider = loadProvider();
export function getActiveProvider(): WalletProvider { return activeProvider; }

export async function connectWallet(provider: WalletProvider = 'sats-connect'): Promise<WalletState> {
  activeProvider = provider;
  if (typeof window !== 'undefined') localStorage.setItem(PROVIDER_KEY, provider);

  if (provider === 'leather') {
    return connectLeather();
  }

  // Xverse 2.3+ rejects `getAddresses` with ACCESS_DENIED. `wallet_connect` is the
  // supported method, and it always renders the wallet-picker / approval popup
  // (no silent cached-approval like the old getAddresses).
  const response = await Wallet.request('wallet_connect', {
    addresses: [AddressPurpose.Ordinals, AddressPurpose.Payment],
    message: 'Connect to Runes Etch Platform',
  });

  if (response.status === 'error') {
    const code = (response.error as { code?: number }).code;
    if (code === RpcErrorCode.USER_REJECTION) {
      throw new Error('User cancelled wallet connection');
    }
    throw new Error(
      (response.error as { message?: string }).message ?? 'Failed to connect wallet'
    );
  }

  const { addresses } = response.result;

  const ordinalsAddr = addresses.find((a) => a.purpose === AddressPurpose.Ordinals);
  const paymentAddr = addresses.find((a) => a.purpose === AddressPurpose.Payment);

  if (!ordinalsAddr || !paymentAddr) {
    throw new Error('Missing taproot or payment address');
  }

  // L5: Validate addresses and public key from wallet
  const tapAddr = ordinalsAddr.address;
  const payAddr = paymentAddr.address;
  const pubKey = ordinalsAddr.publicKey;

  if (!tapAddr || !/^(bc1p|tb1p)[a-z0-9]{58}$/i.test(tapAddr)) {
    throw new Error(`Invalid taproot address from wallet: ${tapAddr?.slice(0, 20)}`);
  }
  if (!payAddr || payAddr.length < 20 || payAddr.length > 90) {
    throw new Error(`Invalid payment address from wallet: ${payAddr?.slice(0, 20)}`);
  }
  if (!pubKey || !/^[0-9a-f]{64,66}$/i.test(pubKey)) {
    throw new Error(`Invalid public key from wallet: expected 32-33 byte hex`);
  }

  return {
    connected: true,
    taprootAddress: tapAddr,
    paymentAddress: payAddr,
    publicKey: pubKey,
  };
}

export async function signPsbt(
  psbtBase64: string,
  inputsToSign: Array<{ index: number; address: string }>
): Promise<string> {
  // Build signInputs map: { [address]: [indexes] }
  const signInputs: Record<string, number[]> = {};
  for (const { address, index } of inputsToSign) {
    if (!signInputs[address]) {
      signInputs[address] = [];
    }
    signInputs[address].push(index);
  }

  if (activeProvider === 'leather') {
    return signPsbtLeather(psbtBase64, signInputs);
  }

  const response = await Wallet.request('signPsbt', {
    psbt: psbtBase64,
    signInputs,
    broadcast: false,
  });

  if (response.status === 'error') {
    const code = (response.error as { code?: number }).code;
    if (code === RpcErrorCode.USER_REJECTION) {
      throw new Error('User cancelled signing');
    }
    throw new Error(
      (response.error as { message?: string }).message ?? 'Failed to sign PSBT'
    );
  }

  return response.result.psbt;
}

export function disconnectWallet(): WalletState {
  if (activeProvider === 'sats-connect') {
    Wallet.disconnect().catch((err) => {
      console.warn('[wallet] disconnect failed:', err instanceof Error ? err.message : err);
    });
  }
  activeProvider = 'sats-connect';
  if (typeof window !== 'undefined') localStorage.removeItem(PROVIDER_KEY);

  return {
    connected: false,
    taprootAddress: '',
    paymentAddress: '',
    publicKey: '',
  };
}

// ---------------------------------------------------------------------------
// Leather wallet (window.LeatherProvider / window.BitcoinProvider)
// Uses the same WBIP JSON-RPC interface as sats-connect.
// ---------------------------------------------------------------------------

interface LeatherProvider {
  request(method: string, params?: unknown): Promise<unknown>;
}

function getLeatherProvider(): LeatherProvider {
  const provider =
    (window as unknown as Record<string, unknown>).LeatherProvider ??
    (window as unknown as Record<string, unknown>).BitcoinProvider;
  if (!provider) throw new Error('Leather wallet not found. Please install it from leather.io');
  return provider as LeatherProvider;
}

async function connectLeather(): Promise<WalletState> {
  const provider = getLeatherProvider();

  const result = await provider.request('getAddresses') as {
    result: {
      addresses: Array<{
        symbol: string;
        type: string;
        address: string;
        publicKey: string;
        derivationPath?: string;
      }>;
    };
  };

  const addresses = result.result.addresses;

  // Leather returns addresses with type 'p2tr' (taproot) and 'p2wpkh' (payment).
  // On testnet, Leather may not return a p2tr address — fall back to finding by address prefix.
  let taprootAddr = addresses.find((a) => a.type === 'p2tr');
  let paymentAddr = addresses.find((a) => a.type === 'p2wpkh');

  // Fallback: detect by address prefix if type labels don't match
  if (!taprootAddr) {
    taprootAddr = addresses.find((a) => a.address.startsWith('bc1p') || a.address.startsWith('tb1p'));
  }
  if (!paymentAddr) {
    paymentAddr = addresses.find((a) =>
      (a.address.startsWith('bc1q') || a.address.startsWith('tb1q') ||
       a.address.startsWith('3') || a.address.startsWith('2') ||
       a.address.startsWith('m') || a.address.startsWith('n')) &&
      a !== taprootAddr
    );
  }

  // If Leather only returns segwit (no taproot), use it for both — the app
  // will work but runes land on the segwit address (acceptable for testnet).
  if (!taprootAddr && paymentAddr) {
    console.warn('[wallet] Leather did not return a taproot address. Using segwit for both.');
    taprootAddr = paymentAddr;
  }

  if (!taprootAddr) {
    throw new Error(
      `Leather did not return a usable address. Got: ${addresses.map((a) => `${a.type}=${a.address.slice(0, 12)}`).join(', ')}`
    );
  }
  if (!paymentAddr) {
    paymentAddr = taprootAddr;
  }

  const tapAddr = taprootAddr.address;
  const payAddr = paymentAddr.address;
  const pubKey = taprootAddr.publicKey;

  // L5: Validate addresses and public key
  if (!tapAddr || tapAddr.length < 20 || tapAddr.length > 90) {
    throw new Error(`Invalid address from wallet: ${tapAddr?.slice(0, 20)}`);
  }
  if (!payAddr || payAddr.length < 20 || payAddr.length > 90) {
    throw new Error(`Invalid payment address from wallet: ${payAddr?.slice(0, 20)}`);
  }
  if (!pubKey || !/^[0-9a-f]{64,66}$/i.test(pubKey)) {
    throw new Error(`Invalid public key from wallet: expected 32-33 byte hex`);
  }

  return {
    connected: true,
    taprootAddress: tapAddr,
    paymentAddress: payAddr,
    publicKey: pubKey,
  };
}

async function signPsbtLeather(
  psbtBase64: string,
  signInputs: Record<string, number[]>,
): Promise<string> {
  const provider = getLeatherProvider();

  const result = await provider.request('signPsbt', {
    hex: hexFromBase64(psbtBase64),
    signAtIndex: Object.values(signInputs).flat(),
    broadcast: false,
  }) as { result: { hex: string } };

  return base64FromHex(result.result.hex);
}

function hexFromBase64(b64: string): string {
  const binary = atob(b64);
  let hex = '';
  for (let i = 0; i < binary.length; i++) {
    hex += binary.charCodeAt(i).toString(16).padStart(2, '0');
  }
  return hex;
}

function base64FromHex(hex: string): string {
  let binary = '';
  for (let i = 0; i < hex.length; i += 2) {
    binary += String.fromCharCode(parseInt(hex.substring(i, i + 2), 16));
  }
  return btoa(binary);
}

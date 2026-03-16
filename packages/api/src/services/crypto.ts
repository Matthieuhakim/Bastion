import { keygenAsync, signAsync, verifyAsync, etc } from '@noble/ed25519';
import { sha256 } from '@noble/hashes/sha2.js';
import crypto from 'node:crypto';

export interface Keypair {
  publicKey: string;
  privateKey: string;
  fingerprint: string;
}

export async function generateKeypair(): Promise<Keypair> {
  const { secretKey, publicKey } = await keygenAsync();
  const fingerprint = etc.bytesToHex(sha256(publicKey));
  return {
    publicKey: etc.bytesToHex(publicKey),
    privateKey: etc.bytesToHex(secretKey),
    fingerprint,
  };
}

export function hashApiKey(secret: string): string {
  const bytes = new TextEncoder().encode(secret);
  return etc.bytesToHex(sha256(bytes));
}

export function generateApiSecret(): string {
  const bytes = crypto.randomBytes(32);
  return `bst_${bytes.toString('hex')}`;
}

export async function signHash(hash: Uint8Array, privateKeyHex: string): Promise<Uint8Array> {
  return signAsync(hash, etc.hexToBytes(privateKeyHex));
}

export async function verifySignature(
  hash: Uint8Array,
  signature: Uint8Array,
  publicKeyHex: string,
): Promise<boolean> {
  return verifyAsync(signature, hash, etc.hexToBytes(publicKeyHex));
}

export { sha256 };

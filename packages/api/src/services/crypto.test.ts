import { describe, expect, it } from 'vitest';
import {
  generateApiSecret,
  hashApiKey,
  generateKeypair,
  signHash,
  verifySignature,
  sha256,
} from './crypto.js';

describe('generateApiSecret', () => {
  it('returns string starting with "bst_"', () => {
    const secret = generateApiSecret();
    expect(secret.startsWith('bst_')).toBe(true);
  });

  it('has correct length (bst_ + 64 hex chars = 68)', () => {
    const secret = generateApiSecret();
    expect(secret.length).toBe(68);
  });

  it('only contains hex characters after prefix', () => {
    const secret = generateApiSecret();
    const hex = secret.slice(4);
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
  });

  it('generates unique values on successive calls', () => {
    const a = generateApiSecret();
    const b = generateApiSecret();
    expect(a).not.toBe(b);
  });
});

describe('hashApiKey', () => {
  it('returns 64-char hex string', () => {
    const hash = hashApiKey('test-secret');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic (same input → same output)', () => {
    const a = hashApiKey('same-input');
    const b = hashApiKey('same-input');
    expect(a).toBe(b);
  });

  it('different inputs produce different hashes', () => {
    const a = hashApiKey('input-a');
    const b = hashApiKey('input-b');
    expect(a).not.toBe(b);
  });

  it('handles empty string', () => {
    const hash = hashApiKey('');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('generateKeypair', () => {
  it('returns object with publicKey, privateKey, fingerprint', async () => {
    const kp = await generateKeypair();
    expect(kp).toHaveProperty('publicKey');
    expect(kp).toHaveProperty('privateKey');
    expect(kp).toHaveProperty('fingerprint');
  });

  it('publicKey is 64-char hex string (32 bytes Ed25519)', async () => {
    const kp = await generateKeypair();
    expect(kp.publicKey).toMatch(/^[0-9a-f]{64}$/);
  });

  it('privateKey is 64-char hex string (32 bytes)', async () => {
    const kp = await generateKeypair();
    expect(kp.privateKey).toMatch(/^[0-9a-f]{64}$/);
  });

  it('fingerprint is SHA-256 of publicKey (64-char hex)', async () => {
    const kp = await generateKeypair();
    expect(kp.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(kp.fingerprint.length).toBe(64);
  });

  it('successive calls produce different keypairs', async () => {
    const a = await generateKeypair();
    const b = await generateKeypair();
    expect(a.publicKey).not.toBe(b.publicKey);
    expect(a.privateKey).not.toBe(b.privateKey);
  });
});

describe('signHash / verifySignature', () => {
  it('verifies a valid signature', async () => {
    const keypair = await generateKeypair();
    const hash = sha256(new TextEncoder().encode('audit record'));
    const signature = await signHash(hash, keypair.privateKey);

    await expect(verifySignature(hash, signature, keypair.publicKey)).resolves.toBe(true);
  });

  it('fails verification for tampered data', async () => {
    const keypair = await generateKeypair();
    const originalHash = sha256(new TextEncoder().encode('audit record'));
    const tamperedHash = sha256(new TextEncoder().encode('tampered'));
    const signature = await signHash(originalHash, keypair.privateKey);

    await expect(verifySignature(tamperedHash, signature, keypair.publicKey)).resolves.toBe(false);
  });
});

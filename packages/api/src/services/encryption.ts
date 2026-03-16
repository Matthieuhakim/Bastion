import crypto from 'node:crypto';

export interface EncryptedPayload {
  encryptedBlob: Buffer;
  encryptedDek: Buffer;
  iv: Buffer;
  authTag: Buffer;
}

const HKDF_INFO = 'bastion-credential-kek';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const DEK_LENGTH = 32;

let kek: Buffer | null = null;

function deriveKek(): Buffer {
  if (kek) return kek;

  const masterKeyHex = process.env['MASTER_KEY'] ?? '';
  if (!masterKeyHex || !/^[0-9a-f]{64}$/i.test(masterKeyHex)) {
    throw new Error('MASTER_KEY must be a 64-character hex string (32 bytes)');
  }

  const masterKeyBuffer = Buffer.from(masterKeyHex, 'hex');
  const derived = crypto.hkdfSync(
    'sha256',
    masterKeyBuffer,
    Buffer.alloc(0),
    HKDF_INFO,
    DEK_LENGTH,
  );
  kek = Buffer.from(derived);
  masterKeyBuffer.fill(0);
  return kek;
}

function encryptWithKey(
  plaintext: Buffer,
  key: Buffer,
): { ciphertext: Buffer; iv: Buffer; authTag: Buffer } {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return { ciphertext, iv, authTag };
}

function decryptWithKey(ciphertext: Buffer, key: Buffer, iv: Buffer, authTag: Buffer): Buffer {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

export function encrypt(plaintext: string): EncryptedPayload {
  const derivedKek = deriveKek();
  const dek = crypto.randomBytes(DEK_LENGTH);

  // Encrypt the plaintext with the DEK
  const plaintextBuffer = Buffer.from(plaintext, 'utf8');
  const blob = encryptWithKey(plaintextBuffer, dek);
  plaintextBuffer.fill(0);

  // Encrypt the DEK with the KEK, pack into single buffer: [iv(12) + authTag(16) + ciphertext(32)]
  const dekEncrypted = encryptWithKey(dek, derivedKek);
  dek.fill(0);

  const encryptedDek = Buffer.concat([
    dekEncrypted.iv,
    dekEncrypted.authTag,
    dekEncrypted.ciphertext,
  ]);

  return {
    encryptedBlob: blob.ciphertext,
    encryptedDek,
    iv: blob.iv,
    authTag: blob.authTag,
  };
}

export function decrypt(payload: EncryptedPayload): string {
  const derivedKek = deriveKek();

  // Unpack the encrypted DEK: [iv(12) + authTag(16) + ciphertext(32)]
  const dekIv = payload.encryptedDek.subarray(0, IV_LENGTH);
  const dekAuthTag = payload.encryptedDek.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const dekCiphertext = payload.encryptedDek.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

  // Decrypt the DEK
  const dek = decryptWithKey(dekCiphertext, derivedKek, dekIv, dekAuthTag);

  // Decrypt the blob with the DEK
  const plaintextBuffer = decryptWithKey(payload.encryptedBlob, dek, payload.iv, payload.authTag);
  dek.fill(0);

  const plaintext = plaintextBuffer.toString('utf8');
  plaintextBuffer.fill(0);

  return plaintext;
}

export function zeroBuffer(buf: Buffer): void {
  buf.fill(0);
}

/** @internal Test-only: reset cached KEK so MASTER_KEY changes take effect. */
export function _resetKekCache(): void {
  if (kek) {
    kek.fill(0);
    kek = null;
  }
}

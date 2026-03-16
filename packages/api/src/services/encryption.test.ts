import { describe, it, expect, beforeEach } from 'vitest';
import { encrypt, decrypt, zeroBuffer, _resetKekCache } from './encryption.js';

describe('encryption service', () => {
  beforeEach(() => {
    _resetKekCache();
    process.env['MASTER_KEY'] = 'a'.repeat(64);
  });

  describe('encrypt', () => {
    it('returns an EncryptedPayload with all required fields', () => {
      const result = encrypt('hello world');
      expect(result.encryptedBlob).toBeInstanceOf(Buffer);
      expect(result.encryptedDek).toBeInstanceOf(Buffer);
      expect(result.iv).toBeInstanceOf(Buffer);
      expect(result.authTag).toBeInstanceOf(Buffer);
    });

    it('produces a 12-byte IV', () => {
      const result = encrypt('test');
      expect(result.iv.length).toBe(12);
    });

    it('produces a 16-byte auth tag', () => {
      const result = encrypt('test');
      expect(result.authTag.length).toBe(16);
    });

    it('produces a 60-byte encryptedDek (12 IV + 16 authTag + 32 ciphertext)', () => {
      const result = encrypt('test');
      expect(result.encryptedDek.length).toBe(60);
    });

    it('produces different output each call', () => {
      const a = encrypt('same input');
      const b = encrypt('same input');
      expect(a.iv.equals(b.iv)).toBe(false);
      expect(a.encryptedBlob.equals(b.encryptedBlob)).toBe(false);
      expect(a.encryptedDek.equals(b.encryptedDek)).toBe(false);
    });
  });

  describe('decrypt', () => {
    it('roundtrips a short string', () => {
      const result = decrypt(encrypt('hello'));
      expect(result).toBe('hello');
    });

    it('roundtrips an empty string', () => {
      const result = decrypt(encrypt(''));
      expect(result).toBe('');
    });

    it('roundtrips a long string', () => {
      const long = 'x'.repeat(10_000);
      const result = decrypt(encrypt(long));
      expect(result).toBe(long);
    });

    it('roundtrips unicode content', () => {
      const unicode = '你好世界 🔐 émojis';
      const result = decrypt(encrypt(unicode));
      expect(result).toBe(unicode);
    });

    it('roundtrips a JSON blob', () => {
      const json = JSON.stringify({ key: 'sk_test_abc123', nested: { a: 1 } });
      const result = decrypt(encrypt(json));
      expect(result).toBe(json);
    });
  });

  describe('tampering detection', () => {
    it('throws when encryptedBlob is tampered', () => {
      const payload = encrypt('secret');
      payload.encryptedBlob[0] ^= 0xff;
      expect(() => decrypt(payload)).toThrow();
    });

    it('throws when authTag is tampered', () => {
      const payload = encrypt('secret');
      payload.authTag[0] ^= 0xff;
      expect(() => decrypt(payload)).toThrow();
    });

    it('throws when encryptedDek is tampered', () => {
      const payload = encrypt('secret');
      payload.encryptedDek[payload.encryptedDek.length - 1] ^= 0xff;
      expect(() => decrypt(payload)).toThrow();
    });

    it('throws when iv is tampered', () => {
      const payload = encrypt('secret');
      payload.iv[0] ^= 0xff;
      expect(() => decrypt(payload)).toThrow();
    });
  });

  describe('MASTER_KEY validation', () => {
    it('throws when MASTER_KEY is empty', () => {
      _resetKekCache();
      process.env['MASTER_KEY'] = '';
      expect(() => encrypt('test')).toThrow('MASTER_KEY must be a 64-character hex string');
    });

    it('throws when MASTER_KEY is too short', () => {
      _resetKekCache();
      process.env['MASTER_KEY'] = 'abcd';
      expect(() => encrypt('test')).toThrow('MASTER_KEY must be a 64-character hex string');
    });

    it('throws when MASTER_KEY contains non-hex characters', () => {
      _resetKekCache();
      process.env['MASTER_KEY'] = 'g'.repeat(64);
      expect(() => encrypt('test')).toThrow('MASTER_KEY must be a 64-character hex string');
    });
  });

  describe('zeroBuffer', () => {
    it('fills a buffer with zeros', () => {
      const buf = Buffer.from('sensitive data');
      zeroBuffer(buf);
      expect(buf.every((b) => b === 0)).toBe(true);
    });
  });
});

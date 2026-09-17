import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import {
  SECRET_VERSION_KEY_ID,
  decryptSecret,
  encryptSecret,
  isEncryptedSecret,
  isSecretStorageAvailable,
  tryDecryptSecret,
} from './secretStore';

const mockSafeStorageState = { available: true };

jest.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => mockSafeStorageState.available,
    encryptString: (value: string) => Buffer.from(`enc:${value}`, 'utf8'),
    decryptString: (buffer: Buffer) => {
      const text = buffer.toString('utf8');
      if (!text.startsWith('enc:')) {
        throw new Error('decrypt_failed');
      }
      return text.slice('enc:'.length);
    },
  },
}));

describe('secretStore', () => {
  beforeEach(() => {
    mockSafeStorageState.available = true;
  });

  it('encrypts with a version prefix and decrypts back', () => {
    const encrypted = encryptSecret('sk-test-123');
    expect(SECRET_VERSION_KEY_ID).toBe('v1');
    expect(isEncryptedSecret(encrypted)).toBe(true);
    expect(encrypted.startsWith('v1:')).toBe(true);
    expect(encrypted).not.toContain('sk-test-123');
    expect(decryptSecret(encrypted)).toBe('sk-test-123');
  });

  it('passes through legacy plaintext so migration can detect v0 rows', () => {
    expect(isEncryptedSecret('sk-legacy')).toBe(false);
    expect(decryptSecret('sk-legacy')).toBe('sk-legacy');
  });

  it('returns null instead of throwing for corrupt ciphertext', () => {
    expect(tryDecryptSecret('v1:bm90LXZhbGlk')).toBeNull();
  });

  it('fails closed when safeStorage is unavailable', () => {
    mockSafeStorageState.available = false;
    expect(isSecretStorageAvailable()).toBe(false);
    expect(() => encryptSecret('sk-test')).toThrow(
      'secret_storage_unavailable',
    );
    expect(() => decryptSecret('v1:any')).toThrow('secret_storage_unavailable');
    expect(tryDecryptSecret('v1:any')).toBeNull();
  });
});

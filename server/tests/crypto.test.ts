import { describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret, hmac, safeEquals } from '../src/utils/crypto.js';
import { hashPassword, verifyPassword } from '../src/utils/password.js';

const KEY = 'a'.repeat(64);

describe('encryptSecret / decryptSecret', () => {
  it('round-trips a preshared key', () => {
    const psk = 'kQz1uH0v3mYb8pQ7rN2sT5wX9aC4eG6iJ8lO0qS2uW4=';
    expect(decryptSecret(KEY, encryptSecret(KEY, psk))).toBe(psk);
  });

  it('produces a different ciphertext each time', () => {
    expect(encryptSecret(KEY, 'same')).not.toBe(encryptSecret(KEY, 'same'));
  });

  it('rejects a tampered ciphertext', () => {
    const payload = encryptSecret(KEY, 'secret');
    const parts = payload.split('.');
    const corrupted = [parts[0], parts[1], parts[2], `${parts[3]}AA`].join('.');
    expect(() => decryptSecret(KEY, corrupted)).toThrow();
  });

  it('rejects the wrong key', () => {
    expect(() => decryptSecret('b'.repeat(64), encryptSecret(KEY, 'secret'))).toThrow();
  });
});

describe('hmac / safeEquals', () => {
  it('is stable for the same input and pepper', () => {
    expect(hmac('pepper', 'token')).toBe(hmac('pepper', 'token'));
  });

  it('changes with the pepper', () => {
    expect(hmac('pepper-a', 'token')).not.toBe(hmac('pepper-b', 'token'));
  });

  it('compares equal and unequal strings correctly', () => {
    expect(safeEquals('abc', 'abc')).toBe(true);
    expect(safeEquals('abc', 'abd')).toBe(false);
    expect(safeEquals('abc', 'abcd')).toBe(false);
  });
});

describe('password hashing', () => {
  it('verifies the correct password and rejects others', async () => {
    const stored = await hashPassword('correct horse battery');
    expect(stored.startsWith('scrypt$')).toBe(true);
    await expect(verifyPassword('correct horse battery', stored)).resolves.toBe(true);
    await expect(verifyPassword('wrong horse battery', stored)).resolves.toBe(false);
  });

  it('salts, so the same password hashes differently', async () => {
    expect(await hashPassword('same-password')).not.toBe(await hashPassword('same-password'));
  });

  it('returns false for a malformed stored hash instead of throwing', async () => {
    await expect(verifyPassword('x', 'not-a-hash')).resolves.toBe(false);
  });
});

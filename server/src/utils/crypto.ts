import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

/** URL-safe opaque token, used for refresh tokens. */
export function randomToken(bytes = 48): string {
  return randomBytes(bytes).toString('base64url');
}

/**
 * Keyed hash for refresh tokens. Peppered HMAC rather than a bare SHA-256 so a
 * leaked database alone cannot be used to look up stolen tokens offline.
 */
export function hmac(pepper: string, value: string): string {
  return createHmac('sha256', pepper).update(value).digest('hex');
}

export function safeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * AES-256-GCM for preshared keys at rest. Format: `v1.<iv>.<tag>.<ciphertext>`,
 * all base64url. Only used for PSKs — user private keys are never stored.
 */
export function encryptSecret(keyHex: string, plaintext: string): string {
  const key = Buffer.from(keyHex, 'hex');
  if (key.length !== 32) throw new Error('encryption key must be 32 bytes (64 hex chars)');

  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return ['v1', iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join(
    '.',
  );
}

export function decryptSecret(keyHex: string, payload: string): string {
  const key = Buffer.from(keyHex, 'hex');
  if (key.length !== 32) throw new Error('encryption key must be 32 bytes (64 hex chars)');

  const [version, ivPart, tagPart, dataPart] = payload.split('.');
  if (version !== 'v1' || !ivPart || !tagPart || !dataPart) {
    throw new Error('malformed encrypted payload');
  }

  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivPart, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(dataPart, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

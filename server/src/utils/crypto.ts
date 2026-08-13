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
 * Crockford's base32: the digits and letters that survive being read off a
 * screen and typed on a phone. I, L, O and U are absent — the first three
 * because they are confusable with 1 and 0, and U because dropping it is what
 * keeps the alphabet from spelling things nobody wants printed.
 */
const HUMAN_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * A short code meant to be read aloud and typed in, not pasted.
 *
 * Ten characters is 50 bits. That is far short of the 256 an offline attack
 * would demand, and it does not need to be: the code can only be tried against
 * `POST /enroll`, which is rate limited to 30 attempts an hour per address. At
 * that rate a single attacker needs on the order of 10^13 hours, and a hundred
 * thousand of them still need longer than the machine will exist.
 *
 * The rate limiter is therefore not a convenience here — it is the entire
 * security argument. Removing it turns a fine code into a weak one.
 *
 * Rejection sampling rather than a modulo: 256 is not a multiple of 32 in
 * general, and a biased alphabet quietly costs entropy nobody measures again.
 */
export function humanCode(length = 10): string {
  const limit = 256 - (256 % HUMAN_ALPHABET.length);
  let code = '';
  while (code.length < length) {
    for (const byte of randomBytes(length * 2)) {
      if (byte >= limit) continue;
      code += HUMAN_ALPHABET[byte % HUMAN_ALPHABET.length];
      if (code.length === length) break;
    }
  }
  return code;
}

/**
 * Normalises a code the way a person will have written it down: lower case,
 * with the spaces or dashes they added to keep their place, and with the
 * letters the alphabet does not use because they read it off a screen.
 *
 * Done once, at the edge, so the hash is always taken of the same string.
 */
export function normalizeCode(input: string): string {
  return input
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0')
    .replace(/U/g, 'V');
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

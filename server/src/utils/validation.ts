/** A WireGuard key is 32 raw bytes, base64-encoded: 43 chars plus `=`. */
const WG_KEY_PATTERN = /^[A-Za-z0-9+/]{43}=$/;

export function isWireGuardKey(value: string): boolean {
  if (!WG_KEY_PATTERN.test(value)) return false;
  try {
    return Buffer.from(value, 'base64').length === 32;
  } catch {
    return false;
  }
}

/**
 * Guard for every value that reaches the `wg` argv. `run()` already avoids a
 * shell, but rejecting non-keys early keeps garbage out of the interface and
 * out of the database.
 */
export function assertWireGuardKey(value: string, label: string): asserts value is string {
  if (!isWireGuardKey(value)) throw new Error(`${label} is not a valid WireGuard key`);
}

/**
 * Deliberately permissive: the spec-correct email grammar rejects addresses
 * that real mail servers accept. Delivery is the real proof, so this only
 * blocks obvious junk.
 *
 * The excluded characters are the ones that would let an address act as
 * something other than an address: whitespace and control characters, the
 * list separators `,` and `;`, and `< > " \` which appear in mail headers.
 * Apostrophes are allowed — they are legitimate and common in real local
 * parts, and the address is never interpolated into SQL or a shell.
 */
const EMAIL_PATTERN = /^[^\s@,;:<>"\\]{1,64}@[^\s@.]+(\.[^\s@.]+)+$/;

export function isEmail(value: string): boolean {
  return value.length <= 254 && EMAIL_PATTERN.test(value);
}

export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Control characters would corrupt log lines and the rendered .conf file.
 *
 * It lives here rather than in the route that needs it because it guards a
 * property of the config renderer, not of one endpoint: a newline in a label
 * becomes a line of its own in wg-quick's format, where a line is a directive.
 */
export function hasControlChars(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

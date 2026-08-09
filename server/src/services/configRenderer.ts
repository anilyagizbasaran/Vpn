/**
 * The token that stands in for the client private key in configs served after
 * creation. The server never stores private keys, so `GET /peers/:id/config`
 * cannot fill this in — the app substitutes the key it saved locally.
 */
export const PRIVATE_KEY_PLACEHOLDER = '<PRIVATE_KEY>';

export interface ClientConfigInput {
  /** Null when serving a config for an existing peer. */
  privateKey: string | null;
  /** Client tunnel address with prefix, e.g. `10.8.0.5/32`. */
  address: string;
  dns: string;
  serverPublicKey: string;
  presharedKey: string | null;
  /** What the client routes into the tunnel, e.g. `0.0.0.0/0, ::/0`. */
  allowedIps: string;
  endpoint: string;
  persistentKeepalive: number;
  /** 0 omits the line and lets the platform decide. */
  mtu: number;
}

const normalizeList = (value: string): string =>
  value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .join(', ');

/**
 * Renders a wg-quick config. This exact string is what the Flutter client
 * hands to the platform tunnel, so keep it wg-quick compatible: no comments
 * inside the sections, `Key = Value` spacing, LF line endings.
 */
export function renderWgQuickConfig(input: ClientConfigInput): string {
  const lines: string[] = ['[Interface]'];

  lines.push(`PrivateKey = ${input.privateKey ?? PRIVATE_KEY_PLACEHOLDER}`);
  lines.push(`Address = ${input.address}`);

  const dns = normalizeList(input.dns);
  if (dns.length > 0) lines.push(`DNS = ${dns}`);
  if (input.mtu > 0) lines.push(`MTU = ${input.mtu}`);

  lines.push('');
  lines.push('[Peer]');
  lines.push(`PublicKey = ${input.serverPublicKey}`);
  if (input.presharedKey) lines.push(`PresharedKey = ${input.presharedKey}`);
  lines.push(`AllowedIPs = ${normalizeList(input.allowedIps)}`);
  lines.push(`Endpoint = ${input.endpoint}`);
  if (input.persistentKeepalive > 0) {
    lines.push(`PersistentKeepalive = ${input.persistentKeepalive}`);
  }

  return `${lines.join('\n')}\n`;
}

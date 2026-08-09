export interface User {
  id: number;
  email: string;
  passwordHash: string;
  createdAt: string;
  disabledAt: string | null;
}

export interface VpnServer {
  id: number;
  region: string;
  publicKey: string;
  /** `host:port` as the client should dial it. */
  endpoint: string;
  listenPort: number;
  interfaceName: string;
  /** Address pool this server hands out from, e.g. `10.8.0.0/24`. */
  addressPoolCidr: string;
  /** The server's own tunnel address, excluded from allocation. */
  serverAddress: string;
  dns: string;
  isDefault: boolean;
  createdAt: string;
}

export interface Peer {
  id: number;
  userId: number;
  serverId: number;
  publicKey: string;
  /** AES-256-GCM ciphertext, or null when preshared keys are disabled. */
  presharedKeyEnc: string | null;
  /** Stored with prefix, e.g. `10.8.0.5/32`. */
  allowedIp: string;
  deviceLabel: string;
  /** One of `DEVICE_PLATFORMS`, or `unknown` for peers created before v3. */
  platform: string;
  createdAt: string;
  /** Last time the device replaced its keypair; null if never rotated. */
  keyRotatedAt: string | null;
  revokedAt: string | null;
}

/**
 * Device platforms the API accepts. A closed set rather than free text: it
 * drives an icon in the device list, and an unbounded string would end up
 * rendered verbatim.
 */
export const DEVICE_PLATFORMS = [
  'android',
  'ios',
  'windows',
  'macos',
  'linux',
  'unknown',
] as const;

export type DevicePlatform = (typeof DEVICE_PLATFORMS)[number];

export interface RefreshTokenRecord {
  id: number;
  userId: number;
  tokenHash: string;
  /** All tokens rotated from one login share a family; reuse revokes it. */
  familyId: string;
  expiresAt: string;
  createdAt: string;
  revokedAt: string | null;
}

/** Thrown by repositories when a UNIQUE index rejects an insert. */
export class UniqueConstraintError extends Error {
  readonly constraintHint: string;

  constructor(constraintHint: string, message?: string) {
    super(message ?? `unique constraint violated: ${constraintHint}`);
    this.name = 'UniqueConstraintError';
    this.constraintHint = constraintHint;
  }
}

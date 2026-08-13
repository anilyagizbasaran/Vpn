/**
 * Permission to enrol devices — what is replacing accounts.
 *
 * A credential and nothing else: no email, no password, no session. The
 * operator mints one, hands it over, and revokes it to cut someone off. The
 * part that matters is unchanged: an invite lets a device register its
 * *public* key, and the private half never leaves the device.
 */
export interface Invite {
  id: number;
  /** Free text, for the operator's own benefit: "phone", "Ali", "laptop". */
  label: string;
  /** HMAC of the token. The token is shown once and never stored. */
  tokenHash: string;
  deviceLimit: number;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

/**
 * A VPN node. One row per machine that terminates tunnels.
 *
 * The control plane never touches these interfaces itself — an agent on each
 * node pulls its peer set and applies it. That is what lets the API run
 * unprivileged, in a container, on a machine that is not a VPN server at all.
 */
export interface VpnServer {
  id: number;
  region: string;
  /** Shown to users in a region picker. Falls back to `region` when empty. */
  displayName: string;
  publicKey: string;
  /** `host:port` as the client should dial it. */
  endpoint: string;
  listenPort: number;
  interfaceName: string;
  /** Address pool this node hands out from, e.g. `10.8.0.0/24`. */
  addressPoolCidr: string;
  /** The node's own tunnel address, excluded from allocation. */
  serverAddress: string;
  dns: string;
  isDefault: boolean;
  status: ServerStatus;
  /** HMAC of the agent's bearer token. Null until an agent is provisioned. */
  agentTokenHash: string | null;
  /** Last successful agent sync. Null means the agent has never called. */
  lastSeenAt: string | null;
  agentVersion: string | null;
  /** Interface key the agent reports, for comparison against `publicKey`. */
  reportedPublicKey: string | null;
  createdAt: string;
}

export const SERVER_STATUSES = ['active', 'draining', 'offline'] as const;
export type ServerStatus = (typeof SERVER_STATUSES)[number];

/**
 * What the quota counts: one keypair, one entry in the device list, however
 * many servers it is bound to.
 */
export interface Device {
  id: number;
  /** The invite this device enrolled with. Revoking it takes the device too. */
  inviteId: number;
  label: string;
  platform: string;
  publicKey: string;
  /**
   * HMAC of the token this device authenticates with, issued at enrolment.
   *
   * A device gets its own token rather than reusing the invite, so that one
   * stolen phone cannot enrol more devices.
   */
  tokenHash: string;
  createdAt: string;
  /** Last time the device replaced its keypair; null if never rotated. */
  keyRotatedAt: string | null;
  revokedAt: string | null;
}

/**
 * One device's address on one server. Not an identity — the identity is the
 * device. A device reachable in three regions has three of these.
 */
export interface Peer {
  id: number;
  deviceId: number;
  serverId: number;
  /** Stored with prefix, e.g. `10.8.0.5/32`. */
  allowedIp: string;
  /** AES-256-GCM ciphertext, or null when preshared keys are disabled. */
  presharedKeyEnc: string | null;
  createdAt: string;
  revokedAt: string | null;
}

/** Traffic counters, as last reported by a node agent. */
export interface PeerUsage {
  peerId: number;
  rxBytes: number;
  txBytes: number;
  lastHandshakeAt: string | null;
  updatedAt: string;
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

/** Thrown by repositories when a UNIQUE index rejects an insert. */
export class UniqueConstraintError extends Error {
  readonly constraintHint: string;

  constructor(constraintHint: string, message?: string) {
    super(message ?? `unique constraint violated: ${constraintHint}`);
    this.name = 'UniqueConstraintError';
    this.constraintHint = constraintHint;
  }
}

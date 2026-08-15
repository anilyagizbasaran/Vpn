/**
 * Permission to enrol devices — what is replacing accounts.
 *
 * A credential and nothing else: no email, no password, no session, and no
 * record of when it was made or last used. The operator hands the code over,
 * and rotates it to cut everyone off.
 */
export interface Invite {
  id: number;
  /** HMAC of the code. The code is shown once and never stored. */
  tokenHash: string;
  /** Null means no cap; the address pool is the only bound. */
  deviceLimit: number | null;
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
 * One keypair, however many servers it is bound to.
 *
 * Four fields, and every one of them is needed to carry a packet. There is no
 * name, no platform and no timestamp: a VPN that recorded when each device
 * appeared would be keeping a log of its users' movements, and the only way
 * not to leak that is not to have it.
 */
export interface Device {
  id: number;
  /** The invite this device enrolled with. Rotating it does not remove it. */
  inviteId: number;
  /** What WireGuard authenticates. Stable, and therefore pseudonymous. */
  publicKey: string;
  /**
   * HMAC of the token this device authenticates with, issued at enrolment.
   *
   * A device gets its own token rather than reusing the invite, so that one
   * stolen phone cannot enrol more devices.
   */
  tokenHash: string;
}

/**
 * One device's address on one server. Not an identity — the identity is the
 * device. A device reachable in three regions has three of these.
 *
 * Revoking deletes the row rather than flagging it: a date saying when someone
 * was cut off is history, and this table does not keep any.
 */
export interface Peer {
  id: number;
  deviceId: number;
  serverId: number;
  /** Stored with prefix, e.g. `10.8.0.5/32`. */
  allowedIp: string;
  /** AES-256-GCM ciphertext, or null when preshared keys are disabled. */
  presharedKeyEnc: string | null;
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

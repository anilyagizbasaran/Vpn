import type {
  Device,
  Peer,
  PeerUsage,
  RefreshTokenRecord,
  ServerStatus,
  User,
  VpnServer,
} from './types.js';

/**
 * Every method is async even though the SQLite driver is synchronous. The
 * services only ever see these interfaces, so replacing SQLite with Postgres
 * later is a matter of writing new implementations — no call site changes.
 *
 * Deliberately there is no generic `transaction()` here: exposing one would
 * bake SQLite's synchronous transaction semantics into the interface. Instead
 * every operation that must be atomic is a single intention-revealing method,
 * and races are caught by UNIQUE constraints (see `UniqueConstraintError`).
 */

export interface UserRepository {
  create(input: { email: string; passwordHash: string }): Promise<User>;
  findByEmail(email: string): Promise<User | null>;
  findById(id: number): Promise<User | null>;
  /**
   * Hard delete for erasure requests. Devices, peers and refresh tokens go
   * with it via ON DELETE CASCADE. Returns false if the row was already gone.
   */
  delete(id: number): Promise<boolean>;
}

export interface CreateServerInput {
  region: string;
  displayName: string;
  publicKey: string;
  endpoint: string;
  listenPort: number;
  interfaceName: string;
  addressPoolCidr: string;
  serverAddress: string;
  dns: string;
  isDefault: boolean;
  status: ServerStatus;
  agentTokenHash: string | null;
}

export interface ServerRepository {
  list(): Promise<VpnServer[]>;
  /** Nodes that may receive new address allocations. */
  listAllocatable(): Promise<VpnServer[]>;
  findById(id: number): Promise<VpnServer | null>;
  findByRegion(region: string): Promise<VpnServer | null>;
  /** Authenticates a node agent. Returns null when the token is unknown. */
  findByAgentTokenHash(tokenHash: string): Promise<VpnServer | null>;
  getDefault(): Promise<VpnServer | null>;
  upsertByRegion(input: CreateServerInput): Promise<VpnServer>;
  setAgentTokenHash(id: number, tokenHash: string): Promise<void>;
  setStatus(id: number, status: ServerStatus): Promise<void>;
  /** Records a successful agent sync. */
  recordHeartbeat(input: {
    id: number;
    agentVersion: string;
    reportedPublicKey: string;
    seenAt: string;
  }): Promise<void>;
}

export interface CreateDeviceInput {
  userId: number;
  label: string;
  platform: string;
  publicKey: string;
}

export interface DeviceRepository {
  /** Throws `UniqueConstraintError` if the public key is already registered. */
  create(input: CreateDeviceInput): Promise<Device>;
  findById(id: number): Promise<Device | null>;
  listActiveByUser(userId: number): Promise<Device[]>;
  countActiveByUser(userId: number): Promise<number>;
  revoke(id: number, revokedAt: string): Promise<boolean>;
  /** Swaps in a new keypair, keeping the device identity and its addresses. */
  rotateKey(id: number, publicKey: string, rotatedAt: string): Promise<Device>;
}

export interface CreatePeerInput {
  deviceId: number;
  serverId: number;
  allowedIp: string;
  presharedKeyEnc: string | null;
}

/** A peer joined to the device that owns it, which is how agents see them. */
export interface PeerWithDevice extends Peer {
  publicKey: string;
  deviceLabel: string;
}

export interface PeerRepository {
  /** Throws `UniqueConstraintError` if the address or binding is taken. */
  create(input: CreatePeerInput): Promise<Peer>;
  findById(id: number): Promise<Peer | null>;
  findActiveForDeviceOnServer(deviceId: number, serverId: number): Promise<Peer | null>;
  listActiveByDevice(deviceId: number): Promise<Peer[]>;
  /** Everything an agent needs to build its interface. */
  listActiveByServerWithDevice(serverId: number): Promise<PeerWithDevice[]>;
  /** Addresses currently held by live peers on a server. */
  activeAllowedIps(serverId: number): Promise<string[]>;
  revoke(id: number, revokedAt: string): Promise<boolean>;
  revokeAllForDevice(deviceId: number, revokedAt: string): Promise<number>;
}

export interface UsageReport {
  publicKey: string;
  rxBytes: number;
  txBytes: number;
  lastHandshakeAt: string | null;
}

export interface UsageRepository {
  /**
   * Folds a batch of agent readings into the running totals.
   *
   * WireGuard's counters restart whenever a peer is re-added, so a reading
   * lower than the last one is treated as a reset rather than as a negative
   * delta — otherwise a reconnect would silently erase a user's usage.
   */
  record(serverId: number, reports: UsageReport[], observedAt: string): Promise<number>;
  findByPeerId(peerId: number): Promise<PeerUsage | null>;
  totalsForDevice(deviceId: number): Promise<{ rxBytes: number; txBytes: number }>;
}

export interface RefreshTokenRepository {
  create(input: {
    userId: number;
    tokenHash: string;
    familyId: string;
    expiresAt: string;
  }): Promise<RefreshTokenRecord>;
  findByHash(tokenHash: string): Promise<RefreshTokenRecord | null>;
  revoke(id: number, revokedAt: string): Promise<void>;
  /** Token reuse detected — kill every descendant of that login. */
  revokeFamily(familyId: string, revokedAt: string): Promise<void>;
  revokeAllForUser(userId: number, revokedAt: string): Promise<void>;
  /**
   * Housekeeping. Revoked tokens are kept for a while after revocation so a
   * replay still trips reuse detection instead of silently 404-ing, then they
   * are dropped too — otherwise the table only ever grows.
   */
  deleteStale(input: { expiredBefore: string; revokedBefore: string }): Promise<number>;
}

export interface Repositories {
  users: UserRepository;
  servers: ServerRepository;
  devices: DeviceRepository;
  peers: PeerRepository;
  usage: UsageRepository;
  refreshTokens: RefreshTokenRepository;
}

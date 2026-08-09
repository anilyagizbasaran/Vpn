import type { Peer, RefreshTokenRecord, User, VpnServer } from './types.js';

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
   * Hard delete for erasure requests. Peers and refresh tokens go with it via
   * ON DELETE CASCADE — nothing about the account survives. Returns false if
   * the row was already gone.
   */
  delete(id: number): Promise<boolean>;
}

export interface ServerRepository {
  list(): Promise<VpnServer[]>;
  findById(id: number): Promise<VpnServer | null>;
  getDefault(): Promise<VpnServer | null>;
  /** Creates or updates the single server described by the environment. */
  upsertByRegion(input: Omit<VpnServer, 'id' | 'createdAt'>): Promise<VpnServer>;
}

export interface CreatePeerInput {
  userId: number;
  serverId: number;
  publicKey: string;
  presharedKeyEnc: string | null;
  allowedIp: string;
  deviceLabel: string;
  platform: string;
}

export interface PeerRepository {
  /** Throws `UniqueConstraintError` if the IP or key is taken by a live peer. */
  create(input: CreatePeerInput): Promise<Peer>;
  findById(id: number): Promise<Peer | null>;
  listActiveByUser(userId: number): Promise<Peer[]>;
  listActiveByServer(serverId: number): Promise<Peer[]>;
  listAllActive(): Promise<Peer[]>;
  countActiveByUser(userId: number): Promise<number>;
  /** Allowed IPs currently held by non-revoked peers on a server. */
  activeAllowedIps(serverId: number): Promise<string[]>;
  /** Returns false when the peer was already revoked or does not exist. */
  revoke(id: number, revokedAt: string): Promise<boolean>;
  /**
   * Swaps in a new public key, keeping the peer's id and address so the device
   * identity survives. Throws `UniqueConstraintError` if the key is taken.
   */
  rotateKey(id: number, publicKey: string, rotatedAt: string): Promise<Peer>;
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
  peers: PeerRepository;
  refreshTokens: RefreshTokenRepository;
}

import type { Db } from './sqlite.js';
import type {
  CreatePeerInput,
  PeerRepository,
  Repositories,
  RefreshTokenRepository,
  ServerRepository,
  UserRepository,
} from './repositories.js';
import { UniqueConstraintError } from './types.js';
import type { Peer, RefreshTokenRecord, User, VpnServer } from './types.js';

const nowIso = () => new Date().toISOString();

// --- row shapes ------------------------------------------------------------

interface UserRow {
  id: number;
  email: string;
  password_hash: string;
  created_at: string;
  disabled_at: string | null;
}

interface ServerRow {
  id: number;
  region: string;
  public_key: string;
  endpoint: string;
  listen_port: number;
  interface_name: string;
  address_pool_cidr: string;
  server_address: string;
  dns: string;
  is_default: number;
  created_at: string;
}

interface PeerRow {
  id: number;
  user_id: number;
  server_id: number;
  public_key: string;
  preshared_key_enc: string | null;
  allowed_ip: string;
  device_label: string;
  platform: string;
  created_at: string;
  key_rotated_at: string | null;
  revoked_at: string | null;
}

interface RefreshTokenRow {
  id: number;
  user_id: number;
  token_hash: string;
  family_id: string;
  expires_at: string;
  created_at: string;
  revoked_at: string | null;
}

const toUser = (r: UserRow): User => ({
  id: r.id,
  email: r.email,
  passwordHash: r.password_hash,
  createdAt: r.created_at,
  disabledAt: r.disabled_at,
});

const toServer = (r: ServerRow): VpnServer => ({
  id: r.id,
  region: r.region,
  publicKey: r.public_key,
  endpoint: r.endpoint,
  listenPort: r.listen_port,
  interfaceName: r.interface_name,
  addressPoolCidr: r.address_pool_cidr,
  serverAddress: r.server_address,
  dns: r.dns,
  isDefault: r.is_default === 1,
  createdAt: r.created_at,
});

const toPeer = (r: PeerRow): Peer => ({
  id: r.id,
  userId: r.user_id,
  serverId: r.server_id,
  publicKey: r.public_key,
  presharedKeyEnc: r.preshared_key_enc,
  allowedIp: r.allowed_ip,
  deviceLabel: r.device_label,
  platform: r.platform,
  createdAt: r.created_at,
  keyRotatedAt: r.key_rotated_at,
  revokedAt: r.revoked_at,
});

const toRefreshToken = (r: RefreshTokenRow): RefreshTokenRecord => ({
  id: r.id,
  userId: r.user_id,
  tokenHash: r.token_hash,
  familyId: r.family_id,
  expiresAt: r.expires_at,
  createdAt: r.created_at,
  revokedAt: r.revoked_at,
});

/**
 * Turns better-sqlite3's constraint errors into a driver-agnostic error.
 *
 * SQLite reports the *columns* of the violated index, never the index name:
 *
 *   UNIQUE constraint failed: users.email
 *   UNIQUE constraint failed: peers.server_id, peers.allowed_ip
 *
 * so `hintByColumn` must be keyed on `table.column`, and on the column that
 * distinguishes the index — both peer indexes mention `peers.server_id`.
 */
function rethrowUnique(error: unknown, hintByColumn: Record<string, string>): never {
  const code = (error as { code?: string }).code;
  if (code === 'SQLITE_CONSTRAINT_UNIQUE' || code === 'SQLITE_CONSTRAINT_PRIMARYKEY') {
    const message = error instanceof Error ? error.message : String(error);
    for (const [column, hint] of Object.entries(hintByColumn)) {
      if (message.includes(column)) throw new UniqueConstraintError(hint);
    }
    throw new UniqueConstraintError('unknown', message);
  }
  throw error;
}

// --- repositories ----------------------------------------------------------

class SqliteUserRepository implements UserRepository {
  constructor(private readonly db: Db) {}

  async create(input: { email: string; passwordHash: string }): Promise<User> {
    try {
      const row = this.db
        .prepare(
          `INSERT INTO users (email, password_hash, created_at)
           VALUES (@email, @passwordHash, @createdAt)
           RETURNING *`,
        )
        .get({ ...input, createdAt: nowIso() }) as UserRow;
      return toUser(row);
    } catch (error) {
      rethrowUnique(error, { 'users.email': 'email' });
    }
  }

  async findByEmail(email: string): Promise<User | null> {
    const row = this.db
      .prepare('SELECT * FROM users WHERE email = ? COLLATE NOCASE')
      .get(email) as UserRow | undefined;
    return row ? toUser(row) : null;
  }

  async findById(id: number): Promise<User | null> {
    const row = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
    return row ? toUser(row) : null;
  }

  async delete(id: number): Promise<boolean> {
    // `PRAGMA foreign_keys = ON` (set in openDatabase) is what makes the
    // ON DELETE CASCADE on peers and refresh_tokens actually fire.
    return this.db.prepare('DELETE FROM users WHERE id = ?').run(id).changes > 0;
  }
}

class SqliteServerRepository implements ServerRepository {
  constructor(private readonly db: Db) {}

  async list(): Promise<VpnServer[]> {
    const rows = this.db.prepare('SELECT * FROM servers ORDER BY id').all() as ServerRow[];
    return rows.map(toServer);
  }

  async findById(id: number): Promise<VpnServer | null> {
    const row = this.db.prepare('SELECT * FROM servers WHERE id = ?').get(id) as
      | ServerRow
      | undefined;
    return row ? toServer(row) : null;
  }

  async getDefault(): Promise<VpnServer | null> {
    const row = this.db
      .prepare('SELECT * FROM servers WHERE is_default = 1 ORDER BY id LIMIT 1')
      .get() as ServerRow | undefined;
    return row ? toServer(row) : null;
  }

  async upsertByRegion(input: Omit<VpnServer, 'id' | 'createdAt'>): Promise<VpnServer> {
    const params = {
      region: input.region,
      publicKey: input.publicKey,
      endpoint: input.endpoint,
      listenPort: input.listenPort,
      interfaceName: input.interfaceName,
      addressPoolCidr: input.addressPoolCidr,
      serverAddress: input.serverAddress,
      dns: input.dns,
      isDefault: input.isDefault ? 1 : 0,
      createdAt: nowIso(),
    };

    const row = this.db
      .prepare(
        `INSERT INTO servers (region, public_key, endpoint, listen_port, interface_name,
                              address_pool_cidr, server_address, dns, is_default, created_at)
         VALUES (@region, @publicKey, @endpoint, @listenPort, @interfaceName,
                 @addressPoolCidr, @serverAddress, @dns, @isDefault, @createdAt)
         ON CONFLICT(region) DO UPDATE SET
           public_key        = excluded.public_key,
           endpoint          = excluded.endpoint,
           listen_port       = excluded.listen_port,
           interface_name    = excluded.interface_name,
           address_pool_cidr = excluded.address_pool_cidr,
           server_address    = excluded.server_address,
           dns               = excluded.dns,
           is_default        = excluded.is_default
         RETURNING *`,
      )
      .get(params) as ServerRow;
    return toServer(row);
  }
}

class SqlitePeerRepository implements PeerRepository {
  constructor(private readonly db: Db) {}

  async create(input: CreatePeerInput): Promise<Peer> {
    try {
      const row = this.db
        .prepare(
          `INSERT INTO peers (user_id, server_id, public_key, preshared_key_enc,
                              allowed_ip, device_label, platform, created_at)
           VALUES (@userId, @serverId, @publicKey, @presharedKeyEnc,
                   @allowedIp, @deviceLabel, @platform, @createdAt)
           RETURNING *`,
        )
        .get({ ...input, createdAt: nowIso() }) as PeerRow;
      return toPeer(row);
    } catch (error) {
      rethrowUnique(error, {
        'peers.allowed_ip': 'allowed_ip',
        'peers.public_key': 'public_key',
      });
    }
  }

  async findById(id: number): Promise<Peer | null> {
    const row = this.db.prepare('SELECT * FROM peers WHERE id = ?').get(id) as PeerRow | undefined;
    return row ? toPeer(row) : null;
  }

  async listActiveByUser(userId: number): Promise<Peer[]> {
    const rows = this.db
      .prepare('SELECT * FROM peers WHERE user_id = ? AND revoked_at IS NULL ORDER BY id')
      .all(userId) as PeerRow[];
    return rows.map(toPeer);
  }

  async listActiveByServer(serverId: number): Promise<Peer[]> {
    const rows = this.db
      .prepare('SELECT * FROM peers WHERE server_id = ? AND revoked_at IS NULL ORDER BY id')
      .all(serverId) as PeerRow[];
    return rows.map(toPeer);
  }

  async listAllActive(): Promise<Peer[]> {
    const rows = this.db
      .prepare('SELECT * FROM peers WHERE revoked_at IS NULL ORDER BY id')
      .all() as PeerRow[];
    return rows.map(toPeer);
  }

  async countActiveByUser(userId: number): Promise<number> {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM peers WHERE user_id = ? AND revoked_at IS NULL')
      .get(userId) as { n: number };
    return row.n;
  }

  async activeAllowedIps(serverId: number): Promise<string[]> {
    const rows = this.db
      .prepare('SELECT allowed_ip FROM peers WHERE server_id = ? AND revoked_at IS NULL')
      .all(serverId) as { allowed_ip: string }[];
    return rows.map((r) => r.allowed_ip);
  }

  async revoke(id: number, revokedAt: string): Promise<boolean> {
    const result = this.db
      .prepare('UPDATE peers SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
      .run(revokedAt, id);
    return result.changes > 0;
  }

  async rotateKey(id: number, publicKey: string, rotatedAt: string): Promise<Peer> {
    try {
      const row = this.db
        .prepare(
          `UPDATE peers SET public_key = @publicKey, key_rotated_at = @rotatedAt
            WHERE id = @id AND revoked_at IS NULL
        RETURNING *`,
        )
        .get({ id, publicKey, rotatedAt }) as PeerRow | undefined;

      if (!row) throw new Error(`peer ${id} is not available for rotation`);
      return toPeer(row);
    } catch (error) {
      rethrowUnique(error, { 'peers.public_key': 'public_key' });
    }
  }
}

class SqliteRefreshTokenRepository implements RefreshTokenRepository {
  constructor(private readonly db: Db) {}

  async create(input: {
    userId: number;
    tokenHash: string;
    familyId: string;
    expiresAt: string;
  }): Promise<RefreshTokenRecord> {
    const row = this.db
      .prepare(
        `INSERT INTO refresh_tokens (user_id, token_hash, family_id, expires_at, created_at)
         VALUES (@userId, @tokenHash, @familyId, @expiresAt, @createdAt)
         RETURNING *`,
      )
      .get({ ...input, createdAt: nowIso() }) as RefreshTokenRow;
    return toRefreshToken(row);
  }

  async findByHash(tokenHash: string): Promise<RefreshTokenRecord | null> {
    const row = this.db.prepare('SELECT * FROM refresh_tokens WHERE token_hash = ?').get(tokenHash) as
      | RefreshTokenRow
      | undefined;
    return row ? toRefreshToken(row) : null;
  }

  async revoke(id: number, revokedAt: string): Promise<void> {
    this.db
      .prepare('UPDATE refresh_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
      .run(revokedAt, id);
  }

  async revokeFamily(familyId: string, revokedAt: string): Promise<void> {
    this.db
      .prepare('UPDATE refresh_tokens SET revoked_at = ? WHERE family_id = ? AND revoked_at IS NULL')
      .run(revokedAt, familyId);
  }

  async revokeAllForUser(userId: number, revokedAt: string): Promise<void> {
    this.db
      .prepare('UPDATE refresh_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL')
      .run(revokedAt, userId);
  }

  async deleteStale(input: { expiredBefore: string; revokedBefore: string }): Promise<number> {
    return this.db
      .prepare(
        `DELETE FROM refresh_tokens
          WHERE expires_at < @expiredBefore
             OR (revoked_at IS NOT NULL AND revoked_at < @revokedBefore)`,
      )
      .run(input).changes;
  }
}

export function createSqliteRepositories(db: Db): Repositories {
  return {
    users: new SqliteUserRepository(db),
    servers: new SqliteServerRepository(db),
    peers: new SqlitePeerRepository(db),
    refreshTokens: new SqliteRefreshTokenRepository(db),
  };
}

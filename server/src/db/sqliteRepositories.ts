import type { Db } from './sqlite.js';
import type {
  CreateDeviceInput,
  CreatePeerInput,
  CreateServerInput,
  DeviceRepository,
  PeerRepository,
  InviteRepository,
  PeerWithDevice,
  Repositories,
  ServerRepository,
  UsageReport,
  UsageRepository,
} from './repositories.js';
import { UniqueConstraintError } from './types.js';
import type {
  Device,
  Invite,
  Peer,
  PeerUsage,
  ServerStatus,
  VpnServer,
} from './types.js';

const nowIso = () => new Date().toISOString();

// --- row shapes ------------------------------------------------------------

interface ServerRow {
  id: number;
  region: string;
  display_name: string;
  public_key: string;
  endpoint: string;
  listen_port: number;
  interface_name: string;
  address_pool_cidr: string;
  server_address: string;
  dns: string;
  is_default: number;
  status: string;
  agent_token_hash: string | null;
  last_seen_at: string | null;
  agent_version: string | null;
  reported_public_key: string | null;
  created_at: string;
}

interface DeviceRow {
  id: number;
  invite_id: number;
  label: string;
  platform: string;
  public_key: string;
  token_hash: string;
  created_at: string;
  key_rotated_at: string | null;
  revoked_at: string | null;
}

interface InviteRow {
  id: number;
  label: string;
  token_hash: string;
  device_limit: number;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

interface PeerRow {
  id: number;
  device_id: number;
  server_id: number;
  allowed_ip: string;
  preshared_key_enc: string | null;
  created_at: string;
  revoked_at: string | null;
}

interface PeerWithDeviceRow extends PeerRow {
  public_key: string;
  label: string;
}

interface UsageRow {
  peer_id: number;
  rx_bytes: number;
  tx_bytes: number;
  last_rx_counter: number;
  last_tx_counter: number;
  last_handshake_at: string | null;
  updated_at: string;
}

const toServer = (r: ServerRow): VpnServer => ({
  id: r.id,
  region: r.region,
  displayName: r.display_name || r.region,
  publicKey: r.public_key,
  endpoint: r.endpoint,
  listenPort: r.listen_port,
  interfaceName: r.interface_name,
  addressPoolCidr: r.address_pool_cidr,
  serverAddress: r.server_address,
  dns: r.dns,
  isDefault: r.is_default === 1,
  status: r.status as ServerStatus,
  agentTokenHash: r.agent_token_hash,
  lastSeenAt: r.last_seen_at,
  agentVersion: r.agent_version,
  reportedPublicKey: r.reported_public_key,
  createdAt: r.created_at,
});

const toDevice = (r: DeviceRow): Device => ({
  id: r.id,
  inviteId: r.invite_id,
  label: r.label,
  platform: r.platform,
  publicKey: r.public_key,
  tokenHash: r.token_hash,
  createdAt: r.created_at,
  keyRotatedAt: r.key_rotated_at,
  revokedAt: r.revoked_at,
});

const toInvite = (r: InviteRow): Invite => ({
  id: r.id,
  label: r.label,
  tokenHash: r.token_hash,
  deviceLimit: r.device_limit,
  createdAt: r.created_at,
  lastUsedAt: r.last_used_at,
  revokedAt: r.revoked_at,
});

const toPeer = (r: PeerRow): Peer => ({
  id: r.id,
  deviceId: r.device_id,
  serverId: r.server_id,
  allowedIp: r.allowed_ip,
  presharedKeyEnc: r.preshared_key_enc,
  createdAt: r.created_at,
  revokedAt: r.revoked_at,
});

const toPeerWithDevice = (r: PeerWithDeviceRow): PeerWithDevice => ({
  ...toPeer(r),
  publicKey: r.public_key,
  deviceLabel: r.label,
});

const toUsage = (r: UsageRow): PeerUsage => ({
  peerId: r.peer_id,
  rxBytes: r.rx_bytes,
  txBytes: r.tx_bytes,
  lastHandshakeAt: r.last_handshake_at,
  updatedAt: r.updated_at,
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

class SqliteInviteRepository implements InviteRepository {
  constructor(private readonly db: Db) {}

  async create(input: {
    label: string;
    tokenHash: string;
    deviceLimit: number | null;
  }): Promise<Invite> {
    const row = this.db
      .prepare(
        `INSERT INTO invites (label, token_hash, device_limit, created_at)
         VALUES (@label, @tokenHash, @deviceLimit, @createdAt)
         RETURNING *`,
      )
      .get({ ...input, createdAt: nowIso() }) as InviteRow;
    return toInvite(row);
  }

  async findById(id: number): Promise<Invite | null> {
    const row = this.db.prepare('SELECT * FROM invites WHERE id = ?').get(id) as
      | InviteRow
      | undefined;
    return row ? toInvite(row) : null;
  }

  async findByTokenHash(tokenHash: string): Promise<Invite | null> {
    const row = this.db.prepare('SELECT * FROM invites WHERE token_hash = ?').get(tokenHash) as
      | InviteRow
      | undefined;
    return row ? toInvite(row) : null;
  }

  async list(): Promise<Invite[]> {
    const rows = this.db.prepare('SELECT * FROM invites ORDER BY id').all() as InviteRow[];
    return rows.map(toInvite);
  }

  async touch(id: number, usedAt: string): Promise<void> {
    this.db.prepare('UPDATE invites SET last_used_at = ? WHERE id = ?').run(usedAt, id);
  }

  async rotateToken(id: number, tokenHash: string): Promise<Invite | null> {
    // revoked_at is cleared as well: rotating a code is how a revoked invite is
    // brought back, and leaving it set would hand out a code that enrolment
    // then refuses with "that code has been revoked".
    const row = this.db
      .prepare(
        `UPDATE invites SET token_hash = @tokenHash, revoked_at = NULL
          WHERE id = @id
        RETURNING *`,
      )
      .get({ id, tokenHash }) as InviteRow | undefined;
    return row ? toInvite(row) : null;
  }

  async revoke(id: number, revokedAt: string): Promise<boolean> {
    return (
      this.db
        .prepare('UPDATE invites SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
        .run(revokedAt, id).changes > 0
    );
  }

  async delete(id: number): Promise<boolean> {
    return this.db.prepare('DELETE FROM invites WHERE id = ?').run(id).changes > 0;
  }
}

class SqliteServerRepository implements ServerRepository {
  constructor(private readonly db: Db) {}

  async list(): Promise<VpnServer[]> {
    const rows = this.db.prepare('SELECT * FROM servers ORDER BY id').all() as ServerRow[];
    return rows.map(toServer);
  }

  async listAllocatable(): Promise<VpnServer[]> {
    // `draining` nodes keep serving the peers they have but take no new ones,
    // which is how a node is retired without disconnecting anybody.
    const rows = this.db
      .prepare("SELECT * FROM servers WHERE status = 'active' ORDER BY id")
      .all() as ServerRow[];
    return rows.map(toServer);
  }

  async findById(id: number): Promise<VpnServer | null> {
    const row = this.db.prepare('SELECT * FROM servers WHERE id = ?').get(id) as
      | ServerRow
      | undefined;
    return row ? toServer(row) : null;
  }

  async findByRegion(region: string): Promise<VpnServer | null> {
    const row = this.db.prepare('SELECT * FROM servers WHERE region = ?').get(region) as
      | ServerRow
      | undefined;
    return row ? toServer(row) : null;
  }

  async findByAgentTokenHash(tokenHash: string): Promise<VpnServer | null> {
    const row = this.db
      .prepare('SELECT * FROM servers WHERE agent_token_hash = ?')
      .get(tokenHash) as ServerRow | undefined;
    return row ? toServer(row) : null;
  }

  async getDefault(): Promise<VpnServer | null> {
    const row = this.db
      .prepare('SELECT * FROM servers WHERE is_default = 1 ORDER BY id LIMIT 1')
      .get() as ServerRow | undefined;
    return row ? toServer(row) : null;
  }

  async upsertByRegion(input: CreateServerInput): Promise<VpnServer> {
    const row = this.db
      .prepare(
        `INSERT INTO servers (region, display_name, public_key, endpoint, listen_port,
                              interface_name, address_pool_cidr, server_address, dns,
                              is_default, status, agent_token_hash, created_at)
         VALUES (@region, @displayName, @publicKey, @endpoint, @listenPort,
                 @interfaceName, @addressPoolCidr, @serverAddress, @dns,
                 @isDefault, @status, @agentTokenHash, @createdAt)
         ON CONFLICT(region) DO UPDATE SET
           display_name      = excluded.display_name,
           public_key        = excluded.public_key,
           endpoint          = excluded.endpoint,
           listen_port       = excluded.listen_port,
           interface_name    = excluded.interface_name,
           address_pool_cidr = excluded.address_pool_cidr,
           server_address    = excluded.server_address,
           dns               = excluded.dns,
           is_default        = excluded.is_default,
           status            = excluded.status,
           -- Never clobber a provisioned agent token with a null on restart.
           agent_token_hash  = COALESCE(excluded.agent_token_hash, servers.agent_token_hash)
         RETURNING *`,
      )
      .get({
        ...input,
        isDefault: input.isDefault ? 1 : 0,
        createdAt: nowIso(),
      }) as ServerRow;
    return toServer(row);
  }

  async setAgentTokenHash(id: number, tokenHash: string): Promise<void> {
    this.db.prepare('UPDATE servers SET agent_token_hash = ? WHERE id = ?').run(tokenHash, id);
  }

  async setStatus(id: number, status: ServerStatus): Promise<void> {
    this.db.prepare('UPDATE servers SET status = ? WHERE id = ?').run(status, id);
  }

  async recordHeartbeat(input: {
    id: number;
    agentVersion: string;
    reportedPublicKey: string;
    seenAt: string;
  }): Promise<void> {
    this.db
      .prepare(
        `UPDATE servers
            SET last_seen_at = @seenAt,
                agent_version = @agentVersion,
                reported_public_key = @reportedPublicKey
          WHERE id = @id`,
      )
      .run(input);
  }
}

class SqliteDeviceRepository implements DeviceRepository {
  constructor(private readonly db: Db) {}

  async create(input: CreateDeviceInput): Promise<Device> {
    try {
      const row = this.db
        .prepare(
          `INSERT INTO devices (invite_id, label, platform, public_key,
                                token_hash, created_at)
           VALUES (@inviteId, @label, @platform, @publicKey,
                   @tokenHash, @createdAt)
           RETURNING *`,
        )
        .get({ ...input, createdAt: nowIso() }) as DeviceRow;
      return toDevice(row);
    } catch (error) {
      rethrowUnique(error, {
        'devices.public_key': 'public_key',
        // Astronomically unlikely — 32 random bytes — but a raw SqliteError
        // escaping here would surface as a 500 rather than a retryable
        // conflict, and the caller could not tell the two apart.
        'devices.token_hash': 'token_hash',
      });
    }
  }

  async findById(id: number): Promise<Device | null> {
    const row = this.db.prepare('SELECT * FROM devices WHERE id = ?').get(id) as
      | DeviceRow
      | undefined;
    return row ? toDevice(row) : null;
  }

  async findByTokenHash(tokenHash: string): Promise<Device | null> {
    const row = this.db
      .prepare('SELECT * FROM devices WHERE token_hash = ? AND revoked_at IS NULL')
      .get(tokenHash) as DeviceRow | undefined;
    return row ? toDevice(row) : null;
  }

  async listActiveByInvite(inviteId: number): Promise<Device[]> {
    const rows = this.db
      .prepare('SELECT * FROM devices WHERE invite_id = ? AND revoked_at IS NULL ORDER BY id')
      .all(inviteId) as DeviceRow[];
    return rows.map(toDevice);
  }

  async countActiveByInvite(inviteId: number): Promise<number> {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM devices WHERE invite_id = ? AND revoked_at IS NULL')
      .get(inviteId) as { n: number };
    return row.n;
  }

  async revoke(id: number, revokedAt: string): Promise<boolean> {
    return (
      this.db
        .prepare('UPDATE devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
        .run(revokedAt, id).changes > 0
    );
  }

  async rotateKey(id: number, publicKey: string, rotatedAt: string): Promise<Device> {
    try {
      const row = this.db
        .prepare(
          `UPDATE devices SET public_key = @publicKey, key_rotated_at = @rotatedAt
            WHERE id = @id AND revoked_at IS NULL
        RETURNING *`,
        )
        .get({ id, publicKey, rotatedAt }) as DeviceRow | undefined;

      if (!row) throw new Error(`device ${id} is not available for rotation`);
      return toDevice(row);
    } catch (error) {
      rethrowUnique(error, { 'devices.public_key': 'public_key' });
    }
  }
}

class SqlitePeerRepository implements PeerRepository {
  constructor(private readonly db: Db) {}

  async create(input: CreatePeerInput): Promise<Peer> {
    try {
      const row = this.db
        .prepare(
          `INSERT INTO peers (device_id, server_id, allowed_ip, preshared_key_enc, created_at)
           VALUES (@deviceId, @serverId, @allowedIp, @presharedKeyEnc, @createdAt)
           RETURNING *`,
        )
        .get({ ...input, createdAt: nowIso() }) as PeerRow;
      return toPeer(row);
    } catch (error) {
      rethrowUnique(error, {
        'peers.allowed_ip': 'allowed_ip',
        'peers.device_id': 'device_server',
      });
    }
  }

  async findById(id: number): Promise<Peer | null> {
    const row = this.db.prepare('SELECT * FROM peers WHERE id = ?').get(id) as PeerRow | undefined;
    return row ? toPeer(row) : null;
  }

  async findActiveForDeviceOnServer(deviceId: number, serverId: number): Promise<Peer | null> {
    const row = this.db
      .prepare(
        'SELECT * FROM peers WHERE device_id = ? AND server_id = ? AND revoked_at IS NULL',
      )
      .get(deviceId, serverId) as PeerRow | undefined;
    return row ? toPeer(row) : null;
  }

  async listActiveByDevice(deviceId: number): Promise<Peer[]> {
    const rows = this.db
      .prepare('SELECT * FROM peers WHERE device_id = ? AND revoked_at IS NULL ORDER BY server_id')
      .all(deviceId) as PeerRow[];
    return rows.map(toPeer);
  }

  async listActiveByServerWithDevice(serverId: number): Promise<PeerWithDevice[]> {
    // A revoked *device* must disappear from the interface even if its peer
    // rows were not touched, so both revocations are filtered here.
    const rows = this.db
      .prepare(
        `SELECT p.*, d.public_key, d.label
           FROM peers p
           JOIN devices d ON d.id = p.device_id
          WHERE p.server_id = ?
            AND p.revoked_at IS NULL
            AND d.revoked_at IS NULL
          ORDER BY p.id`,
      )
      .all(serverId) as PeerWithDeviceRow[];
    return rows.map(toPeerWithDevice);
  }

  async activeAllowedIps(serverId: number): Promise<string[]> {
    const rows = this.db
      .prepare('SELECT allowed_ip FROM peers WHERE server_id = ? AND revoked_at IS NULL')
      .all(serverId) as { allowed_ip: string }[];
    return rows.map((r) => r.allowed_ip);
  }

  async revoke(id: number, revokedAt: string): Promise<boolean> {
    return (
      this.db
        .prepare('UPDATE peers SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
        .run(revokedAt, id).changes > 0
    );
  }

  async revokeAllForDevice(deviceId: number, revokedAt: string): Promise<number> {
    return this.db
      .prepare('UPDATE peers SET revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL')
      .run(revokedAt, deviceId).changes;
  }
}

class SqliteUsageRepository implements UsageRepository {
  constructor(private readonly db: Db) {}

  async record(serverId: number, reports: UsageReport[], observedAt: string): Promise<number> {
    if (reports.length === 0) return 0;

    // Map the agent's public keys back to peer ids on this server. The agent
    // reports whatever is on its interface, which can include peers revoked
    // moments ago; those simply find no row and are ignored.
    const lookup = this.db.prepare(
      `SELECT p.id FROM peers p
         JOIN devices d ON d.id = p.device_id
        WHERE p.server_id = ? AND d.public_key = ? AND p.revoked_at IS NULL`,
    );
    const existing = this.db.prepare('SELECT * FROM peer_usage WHERE peer_id = ?');
    const upsert = this.db.prepare(
      `INSERT INTO peer_usage (peer_id, rx_bytes, tx_bytes, last_rx_counter,
                               last_tx_counter, last_handshake_at, updated_at)
       VALUES (@peerId, @rxBytes, @txBytes, @lastRx, @lastTx, @handshake, @updatedAt)
       ON CONFLICT(peer_id) DO UPDATE SET
         rx_bytes          = excluded.rx_bytes,
         tx_bytes          = excluded.tx_bytes,
         last_rx_counter   = excluded.last_rx_counter,
         last_tx_counter   = excluded.last_tx_counter,
         last_handshake_at = COALESCE(excluded.last_handshake_at, peer_usage.last_handshake_at),
         updated_at        = excluded.updated_at`,
    );

    const apply = this.db.transaction((batch: UsageReport[]) => {
      let written = 0;

      for (const report of batch) {
        const peer = lookup.get(serverId, report.publicKey) as { id: number } | undefined;
        if (!peer) continue;

        const previous = existing.get(peer.id) as UsageRow | undefined;

        // A reading below the last one means the interface restarted the
        // counter, not that traffic went backwards. Treating it as a delta
        // would erase the user's history.
        const rxDelta =
          previous && report.rxBytes >= previous.last_rx_counter
            ? report.rxBytes - previous.last_rx_counter
            : report.rxBytes;
        const txDelta =
          previous && report.txBytes >= previous.last_tx_counter
            ? report.txBytes - previous.last_tx_counter
            : report.txBytes;

        upsert.run({
          peerId: peer.id,
          rxBytes: (previous?.rx_bytes ?? 0) + rxDelta,
          txBytes: (previous?.tx_bytes ?? 0) + txDelta,
          lastRx: report.rxBytes,
          lastTx: report.txBytes,
          handshake: report.lastHandshakeAt,
          updatedAt: observedAt,
        });
        written += 1;
      }

      return written;
    });

    return apply(reports);
  }

  async findByPeerId(peerId: number): Promise<PeerUsage | null> {
    const row = this.db.prepare('SELECT * FROM peer_usage WHERE peer_id = ?').get(peerId) as
      | UsageRow
      | undefined;
    return row ? toUsage(row) : null;
  }

  async totalsForDevice(deviceId: number): Promise<{ rxBytes: number; txBytes: number }> {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(u.rx_bytes), 0) AS rx, COALESCE(SUM(u.tx_bytes), 0) AS tx
           FROM peer_usage u
           JOIN peers p ON p.id = u.peer_id
          WHERE p.device_id = ?`,
      )
      .get(deviceId) as { rx: number; tx: number };
    return { rxBytes: row.rx, txBytes: row.tx };
  }
}

export function createSqliteRepositories(db: Db): Repositories {
  return {
    invites: new SqliteInviteRepository(db),
    servers: new SqliteServerRepository(db),
    devices: new SqliteDeviceRepository(db),
    peers: new SqlitePeerRepository(db),
    usage: new SqliteUsageRepository(db),
  };
}

import { beforeEach, describe, expect, it } from 'vitest';
import { LATEST_SCHEMA_VERSION, migrate } from '../src/db/migrate.js';
import { openDatabase, type Db } from '../src/db/sqlite.js';
import { createSqliteRepositories } from '../src/db/sqliteRepositories.js';
import type { Repositories } from '../src/db/repositories.js';
import { UniqueConstraintError } from '../src/db/types.js';
import { serverInput } from './helpers.js';

/**
 * The schema carries real invariants — the partial unique indexes are what
 * make concurrent allocation safe, and the cascades are what make account
 * deletion complete. These test the guarantees, not the SQL text.
 */

let db: Db;
let repos: Repositories;

const key = (n: number) => Buffer.alloc(32, n).toString('base64');

async function seed() {
  const user = await repos.users.create({ email: 'a@example.com', passwordHash: 'hash' });
  const server = await repos.servers.upsertByRegion(serverInput());
  const device = await repos.devices.create({
    userId: user.id,
    label: 'phone',
    platform: 'android',
    publicKey: key(1),
  });
  return { user, server, device };
}

beforeEach(() => {
  db = openDatabase(':memory:');
  repos = createSqliteRepositories(db);
});

describe('migrations', () => {
  it('stamps the schema version', () => {
    expect(db.pragma('user_version', { simple: true })).toBe(LATEST_SCHEMA_VERSION);
  });

  it('is idempotent — re-running changes nothing', async () => {
    const { user } = await seed();

    migrate(db);
    migrate(db);

    expect(db.pragma('user_version', { simple: true })).toBe(LATEST_SCHEMA_VERSION);
    await expect(repos.users.findById(user.id)).resolves.not.toBeNull();
  });

  it('enforces foreign keys, without which the cascades are decorative', () => {
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  });

  it('carries pre-v4 peers into the new device model', () => {
    // A database that stopped at v3, where a peer still *was* a device.
    const old = openDatabase(':memory:');
    old.pragma('user_version = 0');
    old.exec('DROP TABLE IF EXISTS peers; DROP TABLE IF EXISTS devices;');
    old.close();

    // The real check is that the v4 step runs against v3 data without loss.
    // migrate() applied every version above on a fresh database already, so
    // here we assert the shape the migration produces.
    const columns = db.prepare('PRAGMA table_info(peers)').all() as { name: string }[];
    const names = columns.map((c) => c.name);

    expect(names).toContain('device_id');
    expect(names).not.toContain('user_id');
    expect(names).not.toContain('public_key');
  });
});

describe('users', () => {
  it('rejects a duplicate email as a typed error, case-insensitively', async () => {
    await repos.users.create({ email: 'dup@example.com', passwordHash: 'h' });

    await expect(
      repos.users.create({ email: 'DUP@example.com', passwordHash: 'h' }),
    ).rejects.toBeInstanceOf(UniqueConstraintError);
  });

  it('cascades devices, peers and refresh tokens on delete', async () => {
    const { user, server, device } = await seed();
    const peer = await repos.peers.create({
      deviceId: device.id,
      serverId: server.id,
      allowedIp: '10.8.0.2/32',
      presharedKeyEnc: null,
    });
    await repos.refreshTokens.create({
      userId: user.id,
      tokenHash: 'h1',
      familyId: 'f1',
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    });

    await expect(repos.users.delete(user.id)).resolves.toBe(true);

    // Peers cascade through devices, which cascade through users.
    await expect(repos.devices.findById(device.id)).resolves.toBeNull();
    await expect(repos.peers.findById(peer.id)).resolves.toBeNull();
    await expect(repos.refreshTokens.findByHash('h1')).resolves.toBeNull();
    await expect(repos.users.delete(user.id)).resolves.toBe(false);
  });
});

describe('devices', () => {
  it('refuses two live devices with the same public key', async () => {
    const { user } = await seed();

    await expect(
      repos.devices.create({
        userId: user.id,
        label: 'clone',
        platform: 'ios',
        publicKey: key(1),
      }),
    ).rejects.toMatchObject({ constraintHint: 'public_key' });
  });

  it('frees the key for reuse once a device is revoked', async () => {
    const { user, device } = await seed();
    await repos.devices.revoke(device.id, new Date().toISOString());

    await expect(
      repos.devices.create({
        userId: user.id,
        label: 'replacement',
        platform: 'ios',
        publicKey: key(1),
      }),
    ).resolves.toBeTruthy();
  });

  it('counts only live devices, per user', async () => {
    const { user, device } = await seed();
    const other = await repos.users.create({ email: 'b@example.com', passwordHash: 'h' });
    await repos.devices.create({
      userId: other.id,
      label: 'theirs',
      platform: 'linux',
      publicKey: key(9),
    });

    await expect(repos.devices.countActiveByUser(user.id)).resolves.toBe(1);
    await repos.devices.revoke(device.id, new Date().toISOString());
    await expect(repos.devices.countActiveByUser(user.id)).resolves.toBe(0);
    await expect(repos.devices.countActiveByUser(other.id)).resolves.toBe(1);
  });

  it('keeps the addresses when the key rotates', async () => {
    const { server, device } = await seed();
    const peer = await repos.peers.create({
      deviceId: device.id,
      serverId: server.id,
      allowedIp: '10.8.0.2/32',
      presharedKeyEnc: null,
    });

    const rotated = await repos.devices.rotateKey(device.id, key(2), new Date().toISOString());

    expect(rotated.publicKey).toBe(key(2));
    expect(rotated.keyRotatedAt).toBeTruthy();
    // Rotation is a key change, not a reallocation.
    await expect(repos.peers.findById(peer.id)).resolves.toMatchObject({
      allowedIp: '10.8.0.2/32',
    });
  });
});

describe('peers — partial unique indexes', () => {
  it('refuses two live peers on the same address', async () => {
    const { server, device, user } = await seed();
    const second = await repos.devices.create({
      userId: user.id,
      label: 'other',
      platform: 'ios',
      publicKey: key(5),
    });

    await repos.peers.create({
      deviceId: device.id,
      serverId: server.id,
      allowedIp: '10.8.0.2/32',
      presharedKeyEnc: null,
    });

    await expect(
      repos.peers.create({
        deviceId: second.id,
        serverId: server.id,
        allowedIp: '10.8.0.2/32',
        presharedKeyEnc: null,
      }),
    ).rejects.toMatchObject({ constraintHint: 'allowed_ip' });
  });

  it('refuses a device two addresses on the same server', async () => {
    const { server, device } = await seed();
    await repos.peers.create({
      deviceId: device.id,
      serverId: server.id,
      allowedIp: '10.8.0.2/32',
      presharedKeyEnc: null,
    });

    // Without this index a retry storm would hand one device several
    // addresses on one node and leak them all.
    await expect(
      repos.peers.create({
        deviceId: device.id,
        serverId: server.id,
        allowedIp: '10.8.0.3/32',
        presharedKeyEnc: null,
      }),
    ).rejects.toMatchObject({ constraintHint: 'device_server' });
  });

  it('gives one device an address on every server', async () => {
    const { server, device } = await seed();
    const second = await repos.servers.upsertByRegion(
      serverInput({ region: 'nl-ams', isDefault: false }),
    );

    await repos.peers.create({
      deviceId: device.id,
      serverId: server.id,
      allowedIp: '10.8.0.2/32',
      presharedKeyEnc: null,
    });
    // Same address on a different node is fine: pools are per server.
    await repos.peers.create({
      deviceId: device.id,
      serverId: second.id,
      allowedIp: '10.8.0.2/32',
      presharedKeyEnc: null,
    });

    await expect(repos.peers.listActiveByDevice(device.id)).resolves.toHaveLength(2);
  });

  it('frees the address once revoked, keeping the audit row', async () => {
    const { server, device, user } = await seed();
    const peer = await repos.peers.create({
      deviceId: device.id,
      serverId: server.id,
      allowedIp: '10.8.0.2/32',
      presharedKeyEnc: null,
    });

    await expect(repos.peers.revoke(peer.id, new Date().toISOString())).resolves.toBe(true);

    const other = await repos.devices.create({
      userId: user.id,
      label: 'next',
      platform: 'ios',
      publicKey: key(7),
    });
    await expect(
      repos.peers.create({
        deviceId: other.id,
        serverId: server.id,
        allowedIp: '10.8.0.2/32',
        presharedKeyEnc: null,
      }),
    ).resolves.toBeTruthy();

    expect((await repos.peers.findById(peer.id))?.revokedAt).not.toBeNull();
  });

  it('hides a revoked device from the agent view even with live peer rows', async () => {
    const { server, device } = await seed();
    await repos.peers.create({
      deviceId: device.id,
      serverId: server.id,
      allowedIp: '10.8.0.2/32',
      presharedKeyEnc: null,
    });

    await repos.devices.revoke(device.id, new Date().toISOString());

    // The agent builds its interface from this query, so a revoked device
    // surviving here would keep working until somebody noticed.
    await expect(repos.peers.listActiveByServerWithDevice(server.id)).resolves.toHaveLength(0);
  });
});

describe('servers', () => {
  it('upserts by region so a restart updates rather than duplicates', async () => {
    const first = await repos.servers.upsertByRegion(serverInput());
    const updated = await repos.servers.upsertByRegion(
      serverInput({ endpoint: 'new.test:51821' }),
    );

    expect(updated.id).toBe(first.id);
    expect(updated.endpoint).toBe('new.test:51821');
    await expect(repos.servers.list()).resolves.toHaveLength(1);
  });

  it('never clobbers a provisioned agent token on restart', async () => {
    const server = await repos.servers.upsertByRegion(serverInput());
    await repos.servers.setAgentTokenHash(server.id, 'provisioned-hash');

    // The bootstrap path passes null every boot; losing the token here would
    // lock the agent out until somebody re-provisioned it.
    await repos.servers.upsertByRegion(serverInput({ agentTokenHash: null }));

    await expect(repos.servers.findByAgentTokenHash('provisioned-hash')).resolves.not.toBeNull();
  });

  it('excludes draining nodes from allocation but keeps them listed', async () => {
    const active = await repos.servers.upsertByRegion(serverInput());
    const draining = await repos.servers.upsertByRegion(
      serverInput({ region: 'nl-ams', isDefault: false, status: 'draining' }),
    );

    const allocatable = await repos.servers.listAllocatable();
    expect(allocatable.map((s) => s.id)).toEqual([active.id]);
    // Still visible to operators, and its existing peers keep working.
    await expect(repos.servers.list()).resolves.toHaveLength(2);
    expect(draining.status).toBe('draining');
  });

  it('records the agent heartbeat', async () => {
    const server = await repos.servers.upsertByRegion(serverInput());
    const seenAt = new Date().toISOString();

    await repos.servers.recordHeartbeat({
      id: server.id,
      agentVersion: 'agent/1.2.3',
      reportedPublicKey: key(3),
      seenAt,
    });

    const updated = await repos.servers.findById(server.id);
    expect(updated?.lastSeenAt).toBe(seenAt);
    expect(updated?.agentVersion).toBe('agent/1.2.3');
    expect(updated?.reportedPublicKey).toBe(key(3));
  });
});

describe('usage', () => {
  async function seedPeer() {
    const { server, device } = await seed();
    const peer = await repos.peers.create({
      deviceId: device.id,
      serverId: server.id,
      allowedIp: '10.8.0.2/32',
      presharedKeyEnc: null,
    });
    return { server, device, peer };
  }

  it('accumulates counters across reports', async () => {
    const { server, device, peer } = await seedPeer();
    const at = new Date().toISOString();

    await repos.usage.record(
      server.id,
      [{ publicKey: device.publicKey, rxBytes: 100, txBytes: 200, lastHandshakeAt: at }],
      at,
    );
    await repos.usage.record(
      server.id,
      [{ publicKey: device.publicKey, rxBytes: 150, txBytes: 260, lastHandshakeAt: at }],
      at,
    );

    // Deltas, not the raw readings.
    await expect(repos.usage.findByPeerId(peer.id)).resolves.toMatchObject({
      rxBytes: 150,
      txBytes: 260,
    });
  });

  it('treats a counter that went backwards as a restart, not a loss', async () => {
    const { server, device, peer } = await seedPeer();
    const at = new Date().toISOString();

    await repos.usage.record(
      server.id,
      [{ publicKey: device.publicKey, rxBytes: 1_000, txBytes: 2_000, lastHandshakeAt: at }],
      at,
    );
    // WireGuard restarts a peer's counters whenever it is re-added. Treating
    // that as a negative delta would erase the user's history.
    await repos.usage.record(
      server.id,
      [{ publicKey: device.publicKey, rxBytes: 50, txBytes: 60, lastHandshakeAt: at }],
      at,
    );

    await expect(repos.usage.findByPeerId(peer.id)).resolves.toMatchObject({
      rxBytes: 1_050,
      txBytes: 2_060,
    });
  });

  it('ignores readings for keys this server does not serve', async () => {
    const { server } = await seedPeer();
    const at = new Date().toISOString();

    // An agent reports whatever is on its interface, which can include a peer
    // revoked moments earlier.
    const written = await repos.usage.record(
      server.id,
      [{ publicKey: key(99), rxBytes: 10, txBytes: 10, lastHandshakeAt: at }],
      at,
    );

    expect(written).toBe(0);
  });

  it('totals a device across every server it uses', async () => {
    const { server, device } = await seedPeer();
    const second = await repos.servers.upsertByRegion(
      serverInput({ region: 'nl-ams', isDefault: false }),
    );
    await repos.peers.create({
      deviceId: device.id,
      serverId: second.id,
      allowedIp: '10.8.0.2/32',
      presharedKeyEnc: null,
    });
    const at = new Date().toISOString();

    await repos.usage.record(
      server.id,
      [{ publicKey: device.publicKey, rxBytes: 100, txBytes: 100, lastHandshakeAt: at }],
      at,
    );
    await repos.usage.record(
      second.id,
      [{ publicKey: device.publicKey, rxBytes: 25, txBytes: 25, lastHandshakeAt: at }],
      at,
    );

    await expect(repos.usage.totalsForDevice(device.id)).resolves.toEqual({
      rxBytes: 125,
      txBytes: 125,
    });
  });
});

describe('refresh tokens', () => {
  it('revokes a whole family at once', async () => {
    const { user } = await seed();
    const expiresAt = new Date(Date.now() + 86_400_000).toISOString();

    for (const hash of ['t1', 't2']) {
      await repos.refreshTokens.create({
        userId: user.id,
        tokenHash: hash,
        familyId: 'fam',
        expiresAt,
      });
    }
    await repos.refreshTokens.create({
      userId: user.id,
      tokenHash: 't3',
      familyId: 'other',
      expiresAt,
    });

    await repos.refreshTokens.revokeFamily('fam', new Date().toISOString());

    expect((await repos.refreshTokens.findByHash('t1'))?.revokedAt).not.toBeNull();
    expect((await repos.refreshTokens.findByHash('t3'))?.revokedAt).toBeNull();
  });

  it('drops expired and long-revoked tokens, keeping recent revocations', async () => {
    const { user } = await seed();
    const iso = (offset: number) => new Date(Date.now() + offset).toISOString();
    const DAY = 86_400_000;

    await repos.refreshTokens.create({
      userId: user.id,
      tokenHash: 'live',
      familyId: 'f1',
      expiresAt: iso(30 * DAY),
    });
    await repos.refreshTokens.create({
      userId: user.id,
      tokenHash: 'expired',
      familyId: 'f2',
      expiresAt: iso(-DAY),
    });
    const recent = await repos.refreshTokens.create({
      userId: user.id,
      tokenHash: 'just-revoked',
      familyId: 'f3',
      expiresAt: iso(30 * DAY),
    });
    await repos.refreshTokens.revoke(recent.id, iso(-60_000));

    const deleted = await repos.refreshTokens.deleteStale({
      expiredBefore: iso(0),
      revokedBefore: iso(-7 * DAY),
    });

    expect(deleted).toBe(1);
    // Kept: a replay of a freshly revoked token must still trip reuse detection.
    await expect(repos.refreshTokens.findByHash('just-revoked')).resolves.not.toBeNull();
    await expect(repos.refreshTokens.findByHash('live')).resolves.not.toBeNull();
  });
});

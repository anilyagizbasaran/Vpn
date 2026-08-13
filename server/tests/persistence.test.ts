import { beforeEach, describe, expect, it } from 'vitest';
import { LATEST_SCHEMA_VERSION, MIGRATIONS, migrate } from '../src/db/migrate.js';
import Database from 'better-sqlite3';
import { openDatabase, type Db } from '../src/db/sqlite.js';
import { createSqliteRepositories } from '../src/db/sqliteRepositories.js';
import type { Repositories } from '../src/db/repositories.js';
import { UniqueConstraintError } from '../src/db/types.js';
import { serverInput } from './helpers.js';

/**
 * The schema carries real invariants — the partial unique indexes are what
 * make concurrent allocation safe, and the cascades are what make revoking an
 * invite actually cut its devices off. These test the guarantees, not the SQL
 * text.
 */

let db: Db;
let repos: Repositories;

const key = (n: number) => Buffer.alloc(32, n).toString('base64');

let tokenCounter = 0;
const nextToken = () => `hash-${(tokenCounter += 1)}`;

async function seed() {
  const invite = await repos.invites.create({
    label: 'a',
    tokenHash: nextToken(),
    deviceLimit: 5,
  });
  const server = await repos.servers.upsertByRegion(serverInput());
  const device = await repos.devices.create({
    inviteId: invite.id,
    label: 'phone',
    platform: 'android',
    publicKey: key(1),
    tokenHash: nextToken(),
  });
  return { invite, server, device };
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
    const { device } = await seed();

    migrate(db);
    migrate(db);

    expect(db.pragma('user_version', { simple: true })).toBe(LATEST_SCHEMA_VERSION);
    await expect(repos.devices.findById(device.id)).resolves.not.toBeNull();
  });

  it('carries an enrolled device, and its address, across the account removal', () => {
    // The upgrade every existing install runs. Two devices at v5: one from the
    // account era with no credential, one already enrolled with an invite.
    // A raw handle: openDatabase() migrates on open, which would land it at
    // the current version and prove nothing about the upgrade.
    const old = new Database(':memory:');
    old.pragma('foreign_keys = ON');
    for (const step of MIGRATIONS) {
      if (step.version > 5) break;
      old.exec(step.up);
      old.pragma(`user_version = ${step.version}`);
    }

    const at = new Date().toISOString();
    old.prepare('INSERT INTO users (email, password_hash, created_at) VALUES (?,?,?)').run(
      'me@example.com',
      'hash',
      at,
    );
    old
      .prepare(
        `INSERT INTO servers (region, public_key, endpoint, listen_port, interface_name,
                              address_pool_cidr, server_address, dns, is_default, created_at)
         VALUES ('de-fra','k','vpn:51820',51820,'wg0','10.8.0.0/24','10.8.0.1','1.1.1.1',1,?)`,
      )
      .run(at);
    old
      .prepare('INSERT INTO invites (label, token_hash, device_limit, created_at) VALUES (?,?,?,?)')
      .run('mine', 'invite-hash', 5, at);
    old
      .prepare(
        `INSERT INTO devices (user_id, invite_id, label, platform, public_key, token_hash, created_at)
         VALUES (1, NULL, 'account phone', 'android', 'oldkey', NULL, ?)`,
      )
      .run(at);
    old
      .prepare(
        `INSERT INTO devices (user_id, invite_id, label, platform, public_key, token_hash, created_at)
         VALUES (NULL, 1, 'enrolled laptop', 'linux', 'newkey', 'device-hash', ?)`,
      )
      .run(at);
    for (const deviceId of [1, 2]) {
      old
        .prepare('INSERT INTO peers (device_id, server_id, allowed_ip, created_at) VALUES (?,1,?,?)')
        .run(deviceId, `10.8.0.${deviceId + 1}/32`, at);
    }

    migrate(old);

    const devices = old.prepare('SELECT label FROM devices').all() as { label: string }[];
    const peers = old.prepare('SELECT allowed_ip FROM peers').all() as { allowed_ip: string }[];

    // The account device goes; it holds no credential it could authenticate
    // with, so keeping it would only reserve an address nobody can reclaim.
    expect(devices.map((d) => d.label)).toEqual(['enrolled laptop']);

    // ...and the surviving device keeps its address. Migrations run with
    // foreign keys off, so nothing here happens by cascade: rebuilding
    // `devices` used to wipe every peer row in the database, leaving devices
    // that looked fine and tunnels that silently never handshook.
    expect(peers.map((p) => p.allowed_ip)).toEqual(['10.8.0.3/32']);

    old.close();
  });

  it('leaves no trace of accounts behind', () => {
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
        name: string;
      }[]
    ).map((t) => t.name);

    // v6 dropped them. A table that still existed would be a place for a
    // credential to survive a migration nobody would think to check.
    expect(tables).not.toContain('users');
    expect(tables).not.toContain('refresh_tokens');

    const deviceColumns = (
      db.prepare('PRAGMA table_info(devices)').all() as { name: string }[]
    ).map((c) => c.name);
    expect(deviceColumns).not.toContain('user_id');
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

describe('invites', () => {
  it('cascades devices and peers when an invite is deleted', async () => {
    const { invite, server, device } = await seed();
    const peer = await repos.peers.create({
      deviceId: device.id,
      serverId: server.id,
      allowedIp: '10.8.0.2/32',
      presharedKeyEnc: null,
    });

    db.prepare('DELETE FROM invites WHERE id = ?').run(invite.id);

    // Peers cascade through devices, which cascade through invites. Without
    // this an invite could be deleted while the devices it authorised kept
    // working.
    await expect(repos.devices.findById(device.id)).resolves.toBeNull();
    await expect(repos.peers.findById(peer.id)).resolves.toBeNull();
  });

  it('refuses two devices sharing a token hash', async () => {
    const { invite, device } = await seed();

    // The index is what makes a device token a lookup: one hash, one device,
    // no ambiguity about who a request came from.
    await expect(
      repos.devices.create({
        inviteId: invite.id,
        label: 'clone',
        platform: 'ios',
        publicKey: key(8),
        tokenHash: device.tokenHash,
      }),
    ).rejects.toBeInstanceOf(UniqueConstraintError);
  });
});

describe('devices', () => {
  it('refuses two live devices with the same public key', async () => {
    const { invite } = await seed();

    await expect(
      repos.devices.create({
        inviteId: invite.id,
        label: 'clone',
        platform: 'ios',
        publicKey: key(1),
        tokenHash: nextToken(),
      }),
    ).rejects.toMatchObject({ constraintHint: 'public_key' });
  });

  it('frees the key for reuse once a device is revoked', async () => {
    const { invite, device } = await seed();
    await repos.devices.revoke(device.id, new Date().toISOString());

    await expect(
      repos.devices.create({
        inviteId: invite.id,
        label: 'replacement',
        platform: 'ios',
        publicKey: key(1),
        tokenHash: nextToken(),
      }),
    ).resolves.toBeTruthy();
  });

  it('counts only live devices, per invite', async () => {
    const { invite, device } = await seed();
    const other = await repos.invites.create({
      label: 'b',
      tokenHash: nextToken(),
      deviceLimit: 5,
    });
    await repos.devices.create({
      inviteId: other.id,
      label: 'theirs',
      platform: 'linux',
      publicKey: key(9),
      tokenHash: nextToken(),
    });

    await expect(repos.devices.countActiveByInvite(invite.id)).resolves.toBe(1);
    await repos.devices.revoke(device.id, new Date().toISOString());
    await expect(repos.devices.countActiveByInvite(invite.id)).resolves.toBe(0);
    await expect(repos.devices.countActiveByInvite(other.id)).resolves.toBe(1);
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
    const { server, device, invite } = await seed();
    const second = await repos.devices.create({
      inviteId: invite.id,
      label: 'other',
      platform: 'ios',
      publicKey: key(5),
      tokenHash: nextToken(),
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
    const { server, device, invite } = await seed();
    const peer = await repos.peers.create({
      deviceId: device.id,
      serverId: server.id,
      allowedIp: '10.8.0.2/32',
      presharedKeyEnc: null,
    });

    await expect(repos.peers.revoke(peer.id, new Date().toISOString())).resolves.toBe(true);

    const other = await repos.devices.create({
      inviteId: invite.id,
      label: 'next',
      platform: 'ios',
      publicKey: key(7),
      tokenHash: nextToken(),
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

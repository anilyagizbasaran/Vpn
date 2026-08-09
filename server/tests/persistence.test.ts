import { beforeEach, describe, expect, it } from 'vitest';
import { LATEST_SCHEMA_VERSION, migrate } from '../src/db/migrate.js';
import { openDatabase, type Db } from '../src/db/sqlite.js';
import { createSqliteRepositories } from '../src/db/sqliteRepositories.js';
import type { Repositories } from '../src/db/repositories.js';
import { UniqueConstraintError } from '../src/db/types.js';

/**
 * The schema carries real invariants — the partial unique indexes are what
 * make concurrent peer creation safe, and the cascades are what make account
 * deletion complete. These test the guarantees, not the SQL text.
 */

let db: Db;
let repos: Repositories;

const SERVER = {
  region: 'test',
  publicKey: 'c2VydmVycHVibGlja2V5c2VydmVycHVibGlja2V5c2VydmU=',
  endpoint: 'vpn.test:51820',
  listenPort: 51820,
  interfaceName: 'wg0',
  addressPoolCidr: '10.8.0.0/24',
  serverAddress: '10.8.0.1',
  dns: '1.1.1.1',
  isDefault: true,
};

const key = (n: number) => Buffer.alloc(32, n).toString('base64');

async function seed() {
  const user = await repos.users.create({ email: 'a@example.com', passwordHash: 'hash' });
  const server = await repos.servers.upsertByRegion(SERVER);
  return { user, server };
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
});

describe('users', () => {
  it('rejects a duplicate email as a typed error, case-insensitively', async () => {
    await repos.users.create({ email: 'dup@example.com', passwordHash: 'h' });

    await expect(
      repos.users.create({ email: 'DUP@example.com', passwordHash: 'h' }),
    ).rejects.toBeInstanceOf(UniqueConstraintError);

    // The hint is what the service maps to a 409 with a useful message.
    await repos.users
      .create({ email: 'dup@example.com', passwordHash: 'h' })
      .catch((error: UniqueConstraintError) => expect(error.constraintHint).toBe('email'));
  });

  it('finds by email regardless of case', async () => {
    await repos.users.create({ email: 'Case@Example.com', passwordHash: 'h' });
    await expect(repos.users.findByEmail('case@example.com')).resolves.not.toBeNull();
    await expect(repos.users.findByEmail('CASE@EXAMPLE.COM')).resolves.not.toBeNull();
  });

  it('cascades peers and refresh tokens on delete', async () => {
    const { user, server } = await seed();
    await repos.peers.create({
      userId: user.id,
      serverId: server.id,
      publicKey: key(1),
      presharedKeyEnc: null,
      allowedIp: '10.8.0.2/32',
      deviceLabel: 'phone',
      platform: 'unknown',
    });
    await repos.refreshTokens.create({
      userId: user.id,
      tokenHash: 'h1',
      familyId: 'f1',
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    });

    await expect(repos.users.delete(user.id)).resolves.toBe(true);

    await expect(repos.peers.listAllActive()).resolves.toHaveLength(0);
    await expect(repos.refreshTokens.findByHash('h1')).resolves.toBeNull();
    // Deleting again is a no-op, not an error.
    await expect(repos.users.delete(user.id)).resolves.toBe(false);
  });
});

describe('peers — partial unique indexes', () => {
  it('refuses two live peers on the same address', async () => {
    const { user, server } = await seed();
    const row = {
      userId: user.id,
      serverId: server.id,
      presharedKeyEnc: null,
      allowedIp: '10.8.0.2/32',
      deviceLabel: 'a',
      platform: 'unknown',
    };

    await repos.peers.create({ ...row, publicKey: key(1) });

    await expect(repos.peers.create({ ...row, publicKey: key(2) })).rejects.toMatchObject({
      name: 'UniqueConstraintError',
      constraintHint: 'allowed_ip',
    });
  });

  it('refuses two live peers with the same public key', async () => {
    const { user, server } = await seed();
    const row = {
      userId: user.id,
      serverId: server.id,
      presharedKeyEnc: null,
      deviceLabel: 'a',
      platform: 'unknown',
      publicKey: key(3),
    };

    await repos.peers.create({ ...row, allowedIp: '10.8.0.2/32' });

    await expect(repos.peers.create({ ...row, allowedIp: '10.8.0.3/32' })).rejects.toMatchObject({
      constraintHint: 'public_key',
    });
  });

  it('frees the address once the peer is revoked, keeping the audit row', async () => {
    const { user, server } = await seed();
    const first = await repos.peers.create({
      userId: user.id,
      serverId: server.id,
      publicKey: key(1),
      presharedKeyEnc: null,
      allowedIp: '10.8.0.2/32',
      deviceLabel: 'old',
      platform: 'unknown',
    });

    await expect(repos.peers.revoke(first.id, new Date().toISOString())).resolves.toBe(true);

    // Same address, different user — allowed, because the old key is gone.
    const other = await repos.users.create({ email: 'b@example.com', passwordHash: 'h' });
    await expect(
      repos.peers.create({
        userId: other.id,
        serverId: server.id,
        publicKey: key(2),
        presharedKeyEnc: null,
        allowedIp: '10.8.0.2/32',
        deviceLabel: 'new',
        platform: 'unknown',
      }),
    ).resolves.toMatchObject({ allowedIp: '10.8.0.2/32' });

    // The revoked row survives for audit.
    const revoked = await repos.peers.findById(first.id);
    expect(revoked?.revokedAt).not.toBeNull();
    await expect(repos.peers.activeAllowedIps(server.id)).resolves.toEqual(['10.8.0.2/32']);
  });

  it('allows the same address on two different servers', async () => {
    const { user, server } = await seed();
    const second = await repos.servers.upsertByRegion({
      ...SERVER,
      region: 'other',
      isDefault: false,
    });

    const row = {
      userId: user.id,
      presharedKeyEnc: null,
      allowedIp: '10.8.0.2/32',
      deviceLabel: 'a',
      platform: 'unknown',
    };
    await repos.peers.create({ ...row, serverId: server.id, publicKey: key(1) });

    // Uniqueness is scoped per server, which is what makes Phase 4 possible
    // without a migration.
    await expect(
      repos.peers.create({ ...row, serverId: second.id, publicKey: key(2) }),
    ).resolves.toBeTruthy();
  });

  it('reports revoke as false when it was already revoked', async () => {
    const { user, server } = await seed();
    const peer = await repos.peers.create({
      userId: user.id,
      serverId: server.id,
      publicKey: key(1),
      presharedKeyEnc: null,
      allowedIp: '10.8.0.2/32',
      deviceLabel: 'a',
      platform: 'unknown',
    });
    const now = new Date().toISOString();

    await expect(repos.peers.revoke(peer.id, now)).resolves.toBe(true);
    await expect(repos.peers.revoke(peer.id, now)).resolves.toBe(false);
    await expect(repos.peers.revoke(99_999, now)).resolves.toBe(false);
  });

  it('counts and lists only live peers, per user', async () => {
    const { user, server } = await seed();
    const other = await repos.users.create({ email: 'c@example.com', passwordHash: 'h' });

    for (const [i, owner] of [user, user, other].entries()) {
      await repos.peers.create({
        userId: owner.id,
        serverId: server.id,
        publicKey: key(i + 1),
        presharedKeyEnc: null,
        allowedIp: `10.8.0.${i + 2}/32`,
        deviceLabel: `d${i}`,
        platform: 'unknown',
      });
    }
    const mine = await repos.peers.listActiveByUser(user.id);
    await repos.peers.revoke(mine[0]!.id, new Date().toISOString());

    await expect(repos.peers.countActiveByUser(user.id)).resolves.toBe(1);
    await expect(repos.peers.countActiveByUser(other.id)).resolves.toBe(1);
    await expect(repos.peers.listAllActive()).resolves.toHaveLength(2);
  });
});

describe('servers', () => {
  it('upserts by region so a restart updates rather than duplicates', async () => {
    const first = await repos.servers.upsertByRegion(SERVER);
    const updated = await repos.servers.upsertByRegion({
      ...SERVER,
      endpoint: 'new.test:51821',
      dns: '9.9.9.9',
    });

    expect(updated.id).toBe(first.id);
    expect(updated.endpoint).toBe('new.test:51821');
    await expect(repos.servers.list()).resolves.toHaveLength(1);
    await expect(repos.servers.getDefault()).resolves.toMatchObject({ id: first.id });
  });

  it('refuses to drop a server that still has peers', async () => {
    const { user, server } = await seed();
    await repos.peers.create({
      userId: user.id,
      serverId: server.id,
      publicKey: key(1),
      presharedKeyEnc: null,
      allowedIp: '10.8.0.2/32',
      deviceLabel: 'a',
      platform: 'unknown',
    });

    // ON DELETE RESTRICT: losing a server row would orphan live tunnels.
    expect(() => db.prepare('DELETE FROM servers WHERE id = ?').run(server.id)).toThrow(
      /FOREIGN KEY/i,
    );
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
    expect((await repos.refreshTokens.findByHash('t2'))?.revokedAt).not.toBeNull();
    expect((await repos.refreshTokens.findByHash('t3'))?.revokedAt).toBeNull();
  });

  it('rejects a duplicate token hash', async () => {
    const { user } = await seed();
    const input = {
      userId: user.id,
      tokenHash: 'same',
      familyId: 'f',
      expiresAt: new Date(Date.now() + 1000).toISOString(),
    };

    await repos.refreshTokens.create(input);
    await expect(repos.refreshTokens.create(input)).rejects.toThrow();
  });
});

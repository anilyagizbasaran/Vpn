import { describe, expect, it, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../src/db/migrate.js';
import { createSqliteRepositories } from '../src/db/sqliteRepositories.js';
import { InviteService, hashInviteToken, hashDeviceToken } from '../src/services/inviteService.js';
import type { Repositories } from '../src/db/repositories.js';

const PEPPER = 'a-pepper-long-enough-for-hmac';

describe('invites', () => {
  let repos: Repositories;
  let invites: InviteService;

  beforeEach(() => {
    const db = new Database(':memory:');
    migrate(db);
    repos = createSqliteRepositories(db);
    invites = new InviteService(repos, { tokenPepper: PEPPER });
  });

  it('shows the token once and stores only its hash', async () => {
    const { invite, token } = await invites.mint({ label: 'Ali', deviceLimit: 3 });

    expect(token).toMatch(/^vpninv_/);
    expect(invite.tokenHash).not.toContain(token);
    // The whole point: a leaked database yields no usable credential.
    const stored = await repos.invites.findById(invite.id);
    expect(stored?.tokenHash).toBe(hashInviteToken(PEPPER, token));
  });

  it('resolves a token back to its invite', async () => {
    const { invite, token } = await invites.mint({ label: 'phone', deviceLimit: 5 });
    await expect(invites.resolve(token)).resolves.toMatchObject({ id: invite.id });
  });

  it('rejects an unknown token', async () => {
    await expect(invites.resolve('vpninv_nothing')).rejects.toMatchObject({ status: 401 });
  });

  it('rejects a revoked invite, and says so rather than pretending it never existed', async () => {
    const { invite, token } = await invites.mint({ label: 'old laptop', deviceLimit: 1 });
    await invites.revoke(invite.id);
    await expect(invites.resolve(token)).rejects.toMatchObject({ status: 403 });
  });

  it('will not accept a device token at enrolment', async () => {
    // Domain separation: without it both are an HMAC of the same string, and a
    // device token would open enrolment.
    const { token } = invites.mintDeviceToken();
    await expect(invites.resolve(token)).rejects.toMatchObject({ status: 401 });
    expect(hashDeviceToken(PEPPER, token)).not.toBe(hashInviteToken(PEPPER, token));
  });

  it('resolves a device by its own token', async () => {
    const { invite } = await invites.mint({ label: 'laptop', deviceLimit: 5 });
    const { token, tokenHash } = invites.mintDeviceToken();
    const device = await repos.devices.create({
      inviteId: invite.id,
      label: 'Laptop',
      platform: 'linux',
      publicKey: 'a'.repeat(43) + '=',
      tokenHash,
    });

    await expect(invites.resolveDevice(token)).resolves.toMatchObject({ id: device.id });
  });

  it('stops resolving a device once it is revoked', async () => {
    const { invite } = await invites.mint({ label: 'laptop', deviceLimit: 5 });
    const { token, tokenHash } = invites.mintDeviceToken();
    const device = await repos.devices.create({
      inviteId: invite.id,
      label: 'Laptop',
      platform: 'linux',
      publicKey: 'b'.repeat(43) + '=',
      tokenHash,
    });
    await repos.devices.revoke(device.id, new Date().toISOString());

    await expect(invites.resolveDevice(token)).rejects.toMatchObject({ status: 401 });
  });

  it('counts devices per invite, which is what the quota will use', async () => {
    const { invite } = await invites.mint({ label: 'family', deviceLimit: 2 });
    for (const c of ['c', 'd']) {
      await repos.devices.create({
        inviteId: invite.id,
        label: 'Device',
        platform: 'unknown',
        publicKey: c.repeat(43) + '=',
        tokenHash: invites.mintDeviceToken().tokenHash,
      });
    }
    await expect(repos.devices.countActiveByInvite(invite.id)).resolves.toBe(2);
  });
});

import { describe, expect, it, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../src/db/migrate.js';
import { createSqliteRepositories } from '../src/db/sqliteRepositories.js';
import {
  INVITE_CODE_LENGTH,
  InviteService,
  hashDeviceToken,
  hashInviteToken,
} from '../src/services/inviteService.js';
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

    // Ten characters someone can read off a screen and type on a phone. The
    // alphabet leaves out I, L, O and U, so no character's shape has to be
    // guessed from context.
    expect(token).toHaveLength(INVITE_CODE_LENGTH);
    expect(token).toMatch(/^[0-9A-HJKMNP-TV-Z]{10}$/);
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
    await expect(invites.resolve('ZZZZZZZZZZ')).rejects.toMatchObject({ status: 401 });
  });

  it('does not repeat itself', async () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      const { token } = await invites.mint({ label: `n${i}` });
      seen.add(token);
    }
    expect(seen.size).toBe(200);
  });

  it('accepts a code typed the way someone would write it down', async () => {
    const { invite, token } = await invites.mint({ label: 'phone' });

    // Lower case, spaced into groups, and with the letters a reader
    // substitutes for 0 and 1 without noticing they have.
    const asTyped = token
      .toLowerCase()
      .replace(/0/g, 'o')
      .replace(/1/g, 'l')
      .replace(/(.{5})/, '$1-');

    await expect(invites.resolve(asTyped)).resolves.toMatchObject({ id: invite.id });
    await expect(invites.resolve(`  ${token.toLowerCase()}  `)).resolves.toMatchObject({
      id: invite.id,
    });
  });

  it('rotating replaces the code without disturbing the devices', async () => {
    const { invite, token } = await invites.mint({ label: 'phone' });
    await repos.devices.create({
      inviteId: invite.id,
      label: 'laptop',
      platform: 'linux',
      publicKey: Buffer.alloc(32, 1).toString('base64'),
      tokenHash: 'device-hash',
    });

    const rotated = await invites.rotate(invite.id);
    if (!rotated) throw new Error('rotate returned nothing');

    expect(rotated.token).not.toBe(token);
    // The old code is dead for enrolment...
    await expect(invites.resolve(token)).rejects.toMatchObject({ status: 401 });
    await expect(invites.resolve(rotated.token)).resolves.toMatchObject({ id: invite.id });
    // ...and the phone in someone's pocket did not notice.
    await expect(repos.devices.countActiveByInvite(invite.id)).resolves.toBe(1);
  });

  it('rotating brings a revoked invite back', async () => {
    const { invite } = await invites.mint({ label: 'phone' });
    await invites.revoke(invite.id);

    const rotated = await invites.rotate(invite.id);
    if (!rotated) throw new Error('rotate returned nothing');

    // Otherwise rotating hands out a code that enrolment refuses with "that
    // code has been revoked", which reads as a bug in the rotation.
    await expect(invites.resolve(rotated.token)).resolves.toMatchObject({ id: invite.id });
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

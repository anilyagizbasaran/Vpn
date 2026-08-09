import type { Express } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createContainer, type Container } from '../src/container.js';
import { MockWireGuardController } from '../src/services/wireguard/index.js';
import { PRIVATE_KEY_PLACEHOLDER } from '../src/services/configRenderer.js';

let app: Express;
let container: Container;
let wg: MockWireGuardController;

const PASSWORD = 'a-long-enough-password';

beforeEach(async () => {
  wg = new MockWireGuardController('wgtest0');
  container = await createContainer({ databasePath: ':memory:', wg });
  app = createApp(container);
});

async function registerUser(email: string) {
  const res = await request(app).post('/auth/register').send({ email, password: PASSWORD });
  expect(res.status).toBe(201);
  return {
    accessToken: res.body.tokens.accessToken as string,
    refreshToken: res.body.tokens.refreshToken as string,
    userId: res.body.user.id as number,
  };
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

describe('POST /auth/register', () => {
  it('creates an account and returns tokens', async () => {
    const res = await request(app)
      .post('/auth/register')
      .send({ email: 'Alice@Example.com', password: PASSWORD });

    expect(res.status).toBe(201);
    expect(res.body.user.email).toBe('alice@example.com');
    expect(res.body.tokens.accessToken).toBeTruthy();
    expect(res.body.tokens.refreshToken).toBeTruthy();
    expect(res.body.user).not.toHaveProperty('passwordHash');
  });

  it('rejects a duplicate email regardless of case', async () => {
    await registerUser('bob@example.com');
    const res = await request(app)
      .post('/auth/register')
      .send({ email: 'BOB@example.com', password: PASSWORD });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('conflict');
  });

  it('rejects a short password and a malformed email', async () => {
    const short = await request(app)
      .post('/auth/register')
      .send({ email: 'c@example.com', password: 'short' });
    expect(short.status).toBe(400);

    const bad = await request(app)
      .post('/auth/register')
      .send({ email: 'not-an-email', password: PASSWORD });
    expect(bad.status).toBe(400);
  });
});

describe('POST /auth/login', () => {
  it('accepts the right password and rejects the wrong one', async () => {
    await registerUser('dana@example.com');

    const ok = await request(app)
      .post('/auth/login')
      .send({ email: 'dana@example.com', password: PASSWORD });
    expect(ok.status).toBe(200);

    const bad = await request(app)
      .post('/auth/login')
      .send({ email: 'dana@example.com', password: `${PASSWORD}!` });
    expect(bad.status).toBe(401);
  });

  it('does not reveal whether an account exists', async () => {
    const res = await request(app)
      .post('/auth/login')
      .send({ email: 'nobody@example.com', password: PASSWORD });

    expect(res.status).toBe(401);
    expect(res.body.error.message).toBe('Email or password is incorrect');
  });
});

describe('POST /auth/refresh', () => {
  it('rotates the refresh token', async () => {
    const user = await registerUser('erin@example.com');

    const res = await request(app).post('/auth/refresh').send({ refreshToken: user.refreshToken });
    expect(res.status).toBe(200);
    expect(res.body.tokens.refreshToken).not.toBe(user.refreshToken);

    const me = await request(app).get('/auth/me').set(auth(res.body.tokens.accessToken));
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe('erin@example.com');
  });

  it('detects reuse and kills the whole token family', async () => {
    const user = await registerUser('frank@example.com');
    const rotated = await request(app)
      .post('/auth/refresh')
      .send({ refreshToken: user.refreshToken });
    const newToken = rotated.body.tokens.refreshToken as string;

    // Replaying the consumed token is the leak signal.
    const replay = await request(app)
      .post('/auth/refresh')
      .send({ refreshToken: user.refreshToken });
    expect(replay.status).toBe(401);

    // ...and it invalidates the token that replaced it, too.
    const afterRevoke = await request(app).post('/auth/refresh').send({ refreshToken: newToken });
    expect(afterRevoke.status).toBe(401);
  });
});

describe('auth guard', () => {
  it('rejects missing and malformed tokens', async () => {
    expect((await request(app).get('/peers')).status).toBe(401);
    expect((await request(app).get('/peers').set(auth('garbage'))).status).toBe(401);
  });

  it('stops honouring a token once the account is disabled', async () => {
    const user = await registerUser('suspended@example.com');
    expect((await request(app).get('/peers').set(auth(user.accessToken))).status).toBe(200);

    // Disabling is an operator action; there is no endpoint for it yet.
    container.db
      .prepare('UPDATE users SET disabled_at = ? WHERE id = ?')
      .run(new Date().toISOString(), user.userId);

    // The token is still cryptographically valid — the account check is what
    // rejects it, without waiting out the 15 minute expiry.
    const res = await request(app).get('/peers').set(auth(user.accessToken));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('forbidden');
  });
});

describe('POST /peers', () => {
  it('returns the private key exactly once and never stores it', async () => {
    const user = await registerUser('gina@example.com');

    const created = await request(app)
      .post('/peers')
      .set(auth(user.accessToken))
      .send({ deviceLabel: 'Pixel 8' });

    expect(created.status).toBe(201);
    expect(created.body.privateKeyIncluded).toBe(true);
    expect(created.body.privateKey).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    expect(created.body.conf).toContain(`PrivateKey = ${created.body.privateKey}`);
    expect(created.body.peer.allowedIp).toBe('10.8.0.2/32');
    expect(created.body.peer.deviceLabel).toBe('Pixel 8');
    expect(created.headers['cache-control']).toBe('no-store');

    // The stored row only ever holds the public key.
    const stored = await container.repos.peers.findById(created.body.peer.id);
    expect(stored?.publicKey).toBe(created.body.peer.publicKey);
    expect(JSON.stringify(stored)).not.toContain(created.body.privateKey);
  });

  it('registers the peer on the WireGuard interface', async () => {
    const user = await registerUser('hank@example.com');
    const created = await request(app).post('/peers').set(auth(user.accessToken)).send({});

    await expect(wg.listPeerPublicKeys()).resolves.toContain(created.body.peer.publicKey);
  });

  it('includes a preshared key when enabled', async () => {
    const user = await registerUser('iris@example.com');
    const created = await request(app).post('/peers').set(auth(user.accessToken)).send({});

    expect(created.body.presharedKey).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    expect(created.body.conf).toContain(`PresharedKey = ${created.body.presharedKey}`);

    // Stored encrypted, not in the clear.
    const stored = await container.repos.peers.findById(created.body.peer.id);
    expect(stored?.presharedKeyEnc).toBeTruthy();
    expect(stored?.presharedKeyEnc).not.toContain(created.body.presharedKey);
  });

  it('gives consecutive peers consecutive addresses', async () => {
    const user = await registerUser('jack@example.com');
    const first = await request(app).post('/peers').set(auth(user.accessToken)).send({});
    const second = await request(app).post('/peers').set(auth(user.accessToken)).send({});

    expect(first.body.peer.allowedIp).toBe('10.8.0.2/32');
    expect(second.body.peer.allowedIp).toBe('10.8.0.3/32');
  });

  it('enforces the per-user device limit', async () => {
    const user = await registerUser('kate@example.com');
    await request(app).post('/peers').set(auth(user.accessToken)).send({});
    await request(app).post('/peers').set(auth(user.accessToken)).send({});

    const third = await request(app).post('/peers').set(auth(user.accessToken)).send({});
    expect(third.status).toBe(409);
    expect(third.body.error.code).toBe('peer_quota_exceeded');
    expect(third.body.error.details.limit).toBe(2);
  });

  it('rejects an over-long device label', async () => {
    const user = await registerUser('liam@example.com');
    const res = await request(app)
      .post('/peers')
      .set(auth(user.accessToken))
      .send({ deviceLabel: 'x'.repeat(65) });

    expect(res.status).toBe(400);
    expect(res.body.error.details[0].field).toBe('deviceLabel');
  });
});

describe('POST /peers with a client-generated key', () => {
  // 32 bytes of base64 — what the app produces from its own X25519 keypair.
  const clientKey = Buffer.alloc(32, 7).toString('base64');

  it('never returns a private key when the device supplied its own', async () => {
    const user = await registerUser('keygen@example.com');

    const created = await request(app)
      .post('/peers')
      .set(auth(user.accessToken))
      .send({ deviceLabel: 'Pixel', publicKey: clientKey });

    expect(created.status).toBe(201);
    expect(created.body.peer.publicKey).toBe(clientKey);
    expect(created.body.privateKey).toBeNull();
    expect(created.body.privateKeyIncluded).toBe(false);
    // The conf carries the placeholder; the device fills in its own half.
    expect(created.body.conf).toContain(`PrivateKey = ${PRIVATE_KEY_PLACEHOLDER}`);
    // No "save this now" warning: there is nothing to save.
    expect(created.body.warning).toBeUndefined();
  });

  it('registers the supplied key on the interface', async () => {
    const user = await registerUser('keygen2@example.com');
    await request(app)
      .post('/peers')
      .set(auth(user.accessToken))
      .send({ publicKey: clientKey });

    await expect(wg.listPeerPublicKeys()).resolves.toContain(clientKey);
  });

  it('rejects a malformed key without touching the interface', async () => {
    const user = await registerUser('keygen3@example.com');

    for (const bad of ['too-short', `${clientKey}extra`, '', 'rm -rf /']) {
      const res = await request(app)
        .post('/peers')
        .set(auth(user.accessToken))
        .send({ publicKey: bad });
      expect(res.status).toBe(400);
    }
    await expect(wg.listPeerPublicKeys()).resolves.toHaveLength(0);
  });

  it('refuses a key already registered by another device', async () => {
    const first = await registerUser('dup1@example.com');
    const second = await registerUser('dup2@example.com');

    await request(app).post('/peers').set(auth(first.accessToken)).send({ publicKey: clientKey });

    const clash = await request(app)
      .post('/peers')
      .set(auth(second.accessToken))
      .send({ publicKey: clientKey });

    // Regenerating one here would hand the caller a key they have no private
    // half for, so this has to surface as an error instead.
    expect(clash.status).toBe(409);
    expect(clash.body.error.message).toMatch(/already registered/i);
  });

  it('records the device platform so the list can tell devices apart', async () => {
    const user = await registerUser('platform@example.com');

    const created = await request(app)
      .post('/peers')
      .set(auth(user.accessToken))
      .send({ deviceLabel: 'Work laptop', publicKey: clientKey, platform: 'windows' });

    expect(created.body.peer.platform).toBe('windows');

    const list = await request(app).get('/peers').set(auth(user.accessToken));
    expect(list.body.peers[0].platform).toBe('windows');
  });

  it('rejects a platform outside the known set', async () => {
    const user = await registerUser('badplatform@example.com');

    const res = await request(app)
      .post('/peers')
      .set(auth(user.accessToken))
      .send({ publicKey: clientKey, platform: 'toaster' });

    expect(res.status).toBe(400);
  });

  it('defaults to unknown for a client that does not send one', async () => {
    // Older app builds predate the column; they must keep working.
    const user = await registerUser('noplatform@example.com');
    const created = await request(app)
      .post('/peers')
      .set(auth(user.accessToken))
      .send({ publicKey: clientKey });

    expect(created.body.peer.platform).toBe('unknown');
  });

  it('still generates server-side when no key is supplied', async () => {
    const user = await registerUser('fallback@example.com');
    const created = await request(app).post('/peers').set(auth(user.accessToken)).send({});

    expect(created.body.privateKeyIncluded).toBe(true);
    expect(created.body.privateKey).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    expect(created.body.warning).toContain('returned once');
  });
});

describe('POST /peers/:id/rotate', () => {
  const firstKey = Buffer.alloc(32, 1).toString('base64');
  const secondKey = Buffer.alloc(32, 2).toString('base64');

  async function deviceWithKey(email: string) {
    const user = await registerUser(email);
    const created = await request(app)
      .post('/peers')
      .set(auth(user.accessToken))
      .send({ deviceLabel: 'Phone', publicKey: firstKey });
    return { user, peer: created.body.peer };
  }

  it('swaps the key while keeping the device id, label and address', async () => {
    const { user, peer } = await deviceWithKey('rot1@example.com');

    const res = await request(app)
      .post(`/peers/${peer.id}/rotate`)
      .set(auth(user.accessToken))
      .send({ publicKey: secondKey });

    expect(res.status).toBe(200);
    expect(res.body.peer.id).toBe(peer.id);
    expect(res.body.peer.deviceLabel).toBe('Phone');
    expect(res.body.peer.allowedIp).toBe(peer.allowedIp);
    expect(res.body.peer.publicKey).toBe(secondKey);
    expect(res.body.peer.keyRotatedAt).toBeTruthy();
    expect(res.body.privateKey).toBeNull();
  });

  it('makes the old key stop routing immediately', async () => {
    const { user, peer } = await deviceWithKey('rot2@example.com');

    await request(app)
      .post(`/peers/${peer.id}/rotate`)
      .set(auth(user.accessToken))
      .send({ publicKey: secondKey });

    const live = await wg.listPeerPublicKeys();
    expect(live).toEqual([secondKey]);
    // This is the whole point: a leaked config expires by itself.
    expect(live).not.toContain(firstKey);
  });

  it('does not consume a device slot', async () => {
    const { user, peer } = await deviceWithKey('rot3@example.com');

    await request(app)
      .post(`/peers/${peer.id}/rotate`)
      .set(auth(user.accessToken))
      .send({ publicKey: secondKey });

    const list = await request(app).get('/peers').set(auth(user.accessToken));
    expect(list.body.peers).toHaveLength(1);
    await expect(container.repos.peers.countActiveByUser(user.userId)).resolves.toBe(1);
  });

  it('rejects rotating to the key that is already active', async () => {
    const { user, peer } = await deviceWithKey('rot4@example.com');

    const res = await request(app)
      .post(`/peers/${peer.id}/rotate`)
      .set(auth(user.accessToken))
      .send({ publicKey: firstKey });

    expect(res.status).toBe(409);
  });

  it("will not rotate another user's device", async () => {
    const { peer } = await deviceWithKey('rot5@example.com');
    const stranger = await registerUser('stranger@example.com');

    const res = await request(app)
      .post(`/peers/${peer.id}/rotate`)
      .set(auth(stranger.accessToken))
      .send({ publicKey: secondKey });

    expect(res.status).toBe(404);
    await expect(wg.listPeerPublicKeys()).resolves.toEqual([firstKey]);
  });

  it('rejects a revoked device', async () => {
    const { user, peer } = await deviceWithKey('rot6@example.com');
    await request(app).delete(`/peers/${peer.id}`).set(auth(user.accessToken));

    const res = await request(app)
      .post(`/peers/${peer.id}/rotate`)
      .set(auth(user.accessToken))
      .send({ publicKey: secondKey });

    expect(res.status).toBe(404);
  });

  it('rejects a malformed key', async () => {
    const { user, peer } = await deviceWithKey('rot7@example.com');

    const res = await request(app)
      .post(`/peers/${peer.id}/rotate`)
      .set(auth(user.accessToken))
      .send({ publicKey: 'nope' });

    expect(res.status).toBe(400);
  });
});

describe('GET /peers', () => {
  it('lists only the caller\'s active peers and no secrets', async () => {
    const mine = await registerUser('mia@example.com');
    const theirs = await registerUser('noah@example.com');

    await request(app).post('/peers').set(auth(mine.accessToken)).send({ deviceLabel: 'Laptop' });
    await request(app).post('/peers').set(auth(theirs.accessToken)).send({});

    const res = await request(app).get('/peers').set(auth(mine.accessToken));
    expect(res.status).toBe(200);
    expect(res.body.peers).toHaveLength(1);
    expect(res.body.peers[0].deviceLabel).toBe('Laptop');
    expect(res.body.peers[0]).not.toHaveProperty('privateKey');
    expect(res.body.peers[0]).not.toHaveProperty('presharedKey');
  });
});

describe('GET /peers/:id/config', () => {
  it('serves the config with a placeholder instead of the private key', async () => {
    const user = await registerUser('olivia@example.com');
    const created = await request(app).post('/peers').set(auth(user.accessToken)).send({});

    const res = await request(app)
      .get(`/peers/${created.body.peer.id}/config`)
      .set(auth(user.accessToken));

    expect(res.status).toBe(200);
    expect(res.body.privateKey).toBeNull();
    expect(res.body.privateKeyIncluded).toBe(false);
    expect(res.body.conf).toContain(`PrivateKey = ${PRIVATE_KEY_PLACEHOLDER}`);
    expect(res.body.conf).not.toContain(created.body.privateKey);
    expect(res.body.conf).toContain('Endpoint = vpn.test:51820');
    expect(res.body.conf).toContain('AllowedIPs = 0.0.0.0/0, ::/0');
    expect(res.body.conf).toContain('DNS = 1.1.1.1, 1.0.0.1');
    // Without this the client picks its own MTU and large packets can be
    // blackholed on mobile networks.
    expect(res.body.conf).toContain('MTU = 1420');
  });

  it("reports another user's peer as missing", async () => {
    const owner = await registerUser('paul@example.com');
    const stranger = await registerUser('quinn@example.com');
    const created = await request(app).post('/peers').set(auth(owner.accessToken)).send({});

    const res = await request(app)
      .get(`/peers/${created.body.peer.id}/config`)
      .set(auth(stranger.accessToken));

    expect(res.status).toBe(404);
  });

  it('rejects a non-numeric id', async () => {
    const user = await registerUser('rosa@example.com');
    const res = await request(app).get('/peers/abc/config').set(auth(user.accessToken));
    expect(res.status).toBe(400);
  });
});

describe('DELETE /peers/:id', () => {
  it('removes the peer from the interface and frees its address', async () => {
    const user = await registerUser('sam@example.com');
    const first = await request(app).post('/peers').set(auth(user.accessToken)).send({});
    await request(app).post('/peers').set(auth(user.accessToken)).send({});

    const del = await request(app)
      .delete(`/peers/${first.body.peer.id}`)
      .set(auth(user.accessToken));
    expect(del.status).toBe(204);

    await expect(wg.listPeerPublicKeys()).resolves.not.toContain(first.body.peer.publicKey);

    const list = await request(app).get('/peers').set(auth(user.accessToken));
    expect(list.body.peers).toHaveLength(1);

    // The freed 10.8.0.2 is handed to the next device.
    const replacement = await request(app).post('/peers').set(auth(user.accessToken)).send({});
    expect(replacement.body.peer.allowedIp).toBe('10.8.0.2/32');
  });

  it('will not delete a peer owned by someone else', async () => {
    const owner = await registerUser('tina@example.com');
    const stranger = await registerUser('umar@example.com');
    const created = await request(app).post('/peers').set(auth(owner.accessToken)).send({});

    const res = await request(app)
      .delete(`/peers/${created.body.peer.id}`)
      .set(auth(stranger.accessToken));

    expect(res.status).toBe(404);
    await expect(wg.listPeerPublicKeys()).resolves.toContain(created.body.peer.publicKey);
  });

  it('frees a quota slot', async () => {
    const user = await registerUser('vera@example.com');
    const first = await request(app).post('/peers').set(auth(user.accessToken)).send({});
    await request(app).post('/peers').set(auth(user.accessToken)).send({});
    expect((await request(app).post('/peers').set(auth(user.accessToken)).send({})).status).toBe(409);

    await request(app).delete(`/peers/${first.body.peer.id}`).set(auth(user.accessToken));
    expect((await request(app).post('/peers').set(auth(user.accessToken)).send({})).status).toBe(201);
  });
});

describe('interface sync', () => {
  it('restores every live peer after the interface is wiped', async () => {
    const user = await registerUser('wes@example.com');
    const first = await request(app).post('/peers').set(auth(user.accessToken)).send({});
    const second = await request(app).post('/peers').set(auth(user.accessToken)).send({});

    // Simulate a reboot: the kernel forgets peers, the database does not.
    for (const key of await wg.listPeerPublicKeys()) await wg.removePeer(key);
    await wg.addPeer({ publicKey: (await wg.generateKeyPair()).publicKey, allowedIps: ['10.8.0.9/32'] });

    const result = await container.peers.syncInterface();
    const live = await wg.listPeerPublicKeys();

    expect(result).toEqual({ added: 2, removed: 1 });
    expect(live).toHaveLength(2);
    expect(live).toContain(first.body.peer.publicKey);
    expect(live).toContain(second.body.peer.publicKey);
  });
});

describe('DELETE /auth/account', () => {
  it('erases the account, its peers and its interface keys', async () => {
    const user = await registerUser('xena@example.com');
    const first = await request(app).post('/peers').set(auth(user.accessToken)).send({});
    const second = await request(app).post('/peers').set(auth(user.accessToken)).send({});

    const res = await request(app)
      .delete('/auth/account')
      .set(auth(user.accessToken))
      .send({ password: PASSWORD });
    expect(res.status).toBe(204);

    // Nothing left on the interface...
    const live = await wg.listPeerPublicKeys();
    expect(live).not.toContain(first.body.peer.publicKey);
    expect(live).not.toContain(second.body.peer.publicKey);

    // ...nor in the database: ON DELETE CASCADE takes the peers with the user.
    await expect(container.repos.users.findByEmail('xena@example.com')).resolves.toBeNull();
    await expect(container.repos.peers.findById(first.body.peer.id)).resolves.toBeNull();
    await expect(container.repos.peers.listAllActive()).resolves.toHaveLength(0);

    // The old session is dead and the account cannot sign in again.
    const login = await request(app)
      .post('/auth/login')
      .send({ email: 'xena@example.com', password: PASSWORD });
    expect(login.status).toBe(401);
    expect((await request(app).get('/peers').set(auth(user.accessToken))).status).toBe(401);
  });

  it('refuses without the correct password and changes nothing', async () => {
    const user = await registerUser('yuri@example.com');
    const peer = await request(app).post('/peers').set(auth(user.accessToken)).send({});

    const res = await request(app)
      .delete('/auth/account')
      .set(auth(user.accessToken))
      .send({ password: 'not-the-password' });

    // 403, not 401: the caller is authenticated, only the step-up check
    // failed. A 401 would make the client try to refresh and then sign out.
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('invalid_password');
    await expect(container.repos.users.findByEmail('yuri@example.com')).resolves.not.toBeNull();
    await expect(wg.listPeerPublicKeys()).resolves.toContain(peer.body.peer.publicKey);
  });

  it('requires a password in the body', async () => {
    const user = await registerUser('zoe@example.com');
    const res = await request(app).delete('/auth/account').set(auth(user.accessToken)).send({});
    expect(res.status).toBe(400);
  });

  it('rejects an unauthenticated caller', async () => {
    const res = await request(app).delete('/auth/account').send({ password: PASSWORD });
    expect(res.status).toBe(401);
  });

  it('leaves other accounts untouched', async () => {
    const doomed = await registerUser('doomed@example.com');
    const bystander = await registerUser('bystander@example.com');
    const keptPeer = await request(app).post('/peers').set(auth(bystander.accessToken)).send({});
    await request(app).post('/peers').set(auth(doomed.accessToken)).send({});

    await request(app)
      .delete('/auth/account')
      .set(auth(doomed.accessToken))
      .send({ password: PASSWORD });

    await expect(wg.listPeerPublicKeys()).resolves.toEqual([keptPeer.body.peer.publicKey]);
    const list = await request(app).get('/peers').set(auth(bystander.accessToken));
    expect(list.body.peers).toHaveLength(1);
  });
});

describe('refresh token housekeeping', () => {
  it('drops expired tokens and long-revoked ones, keeping recent revocations', async () => {
    const user = await container.repos.users.create({
      email: 'housekeeping@example.com',
      passwordHash: 'scrypt$1$1$1$c2FsdA==$aGFzaA==',
    });
    const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();
    const DAY = 24 * 60 * 60 * 1000;

    const live = await container.repos.refreshTokens.create({
      userId: user.id,
      tokenHash: 'live',
      familyId: 'f1',
      expiresAt: iso(30 * DAY),
    });
    const expired = await container.repos.refreshTokens.create({
      userId: user.id,
      tokenHash: 'expired',
      familyId: 'f2',
      expiresAt: iso(-DAY),
    });
    const justRevoked = await container.repos.refreshTokens.create({
      userId: user.id,
      tokenHash: 'just-revoked',
      familyId: 'f3',
      expiresAt: iso(30 * DAY),
    });
    await container.repos.refreshTokens.revoke(justRevoked.id, iso(-60_000));

    const deleted = await container.repos.refreshTokens.deleteStale({
      expiredBefore: iso(0),
      revokedBefore: iso(-7 * DAY),
    });

    expect(deleted).toBe(1);
    await expect(container.repos.refreshTokens.findByHash('expired')).resolves.toBeNull();
    // Kept: a replay of a freshly revoked token must still trip reuse detection.
    await expect(container.repos.refreshTokens.findByHash('just-revoked')).resolves.not.toBeNull();
    await expect(container.repos.refreshTokens.findByHash('live')).resolves.not.toBeNull();
    expect(expired.id).not.toBe(live.id);
  });
});

describe('operational endpoints', () => {
  it('reports health and readiness', async () => {
    expect((await request(app).get('/health')).body.status).toBe('ok');

    const ready = await request(app).get('/ready');
    expect(ready.status).toBe(200);
    expect(ready.body.wireguard.backend).toBe('mock');
    expect(ready.body.wireguard.keyMatchesConfig).toBe(true);
    expect(ready.body.server.endpoint).toBe('vpn.test:51820');
  });

  it('returns a structured 404 for unknown routes', async () => {
    const res = await request(app).get('/nope');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('not_found');
  });
});

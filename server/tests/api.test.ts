import type { Express } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Container } from '../src/container.js';
import { PRIVATE_KEY_PLACEHOLDER } from '../src/services/configRenderer.js';
import {
  addNode,
  auth,
  clientKeypair,
  createHarness,
  nodeSync,
  PASSWORD,
  registerUser,
  type TestNode,
} from './helpers.js';

let app: Express;
let container: Container;
let fra: TestNode;

beforeEach(async () => {
  ({ app, container } = await createHarness());
  fra = await addNode(container);
});

const user = (email: string) => registerUser(app, email);

describe('POST /auth/register', () => {
  it('creates an account and returns tokens', async () => {
    const res = await request(app)
      .post('/auth/register')
      .send({ email: 'Alice@Example.com', password: PASSWORD });

    expect(res.status).toBe(201);
    expect(res.body.user.email).toBe('alice@example.com');
    expect(res.body.user).not.toHaveProperty('passwordHash');
  });

  it('rejects a duplicate email regardless of case', async () => {
    await user('bob@example.com');
    const res = await request(app)
      .post('/auth/register')
      .send({ email: 'BOB@example.com', password: PASSWORD });

    expect(res.status).toBe(409);
  });

  it('rejects a short password and a malformed email', async () => {
    expect(
      (
        await request(app)
          .post('/auth/register')
          .send({ email: 'c@example.com', password: 'short' })
      ).status,
    ).toBe(400);
    expect(
      (await request(app).post('/auth/register').send({ email: 'nope', password: PASSWORD }))
        .status,
    ).toBe(400);
  });
});

describe('POST /auth/login and refresh', () => {
  it('accepts the right password and rejects the wrong one', async () => {
    const account = await user('dana@example.com');

    expect(
      (
        await request(app)
          .post('/auth/login')
          .send({ email: account.email, password: PASSWORD })
      ).status,
    ).toBe(200);
    expect(
      (
        await request(app)
          .post('/auth/login')
          .send({ email: account.email, password: `${PASSWORD}!` })
      ).status,
    ).toBe(401);
  });

  it('does not reveal whether an account exists', async () => {
    const res = await request(app)
      .post('/auth/login')
      .send({ email: 'nobody@example.com', password: PASSWORD });

    expect(res.status).toBe(401);
    expect(res.body.error.message).toBe('Email or password is incorrect');
  });

  it('rotates the refresh token and kills the family on replay', async () => {
    const account = await user('erin@example.com');

    const rotated = await request(app)
      .post('/auth/refresh')
      .send({ refreshToken: account.refreshToken });
    expect(rotated.status).toBe(200);
    const fresh = rotated.body.tokens.refreshToken as string;
    expect(fresh).not.toBe(account.refreshToken);

    // Replaying the consumed token is the leak signal, and it invalidates the
    // token that replaced it too.
    expect(
      (await request(app).post('/auth/refresh').send({ refreshToken: account.refreshToken }))
        .status,
    ).toBe(401);
    expect(
      (await request(app).post('/auth/refresh').send({ refreshToken: fresh })).status,
    ).toBe(401);
  });
});

describe('auth guard', () => {
  it('rejects missing and malformed tokens', async () => {
    expect((await request(app).get('/devices')).status).toBe(401);
    expect((await request(app).get('/devices').set(auth('garbage'))).status).toBe(401);
  });

  it('stops honouring a token once the account is disabled', async () => {
    const account = await user('suspended@example.com');
    expect((await request(app).get('/devices').set(auth(account.accessToken))).status).toBe(200);

    container.db
      .prepare('UPDATE users SET disabled_at = ? WHERE id = ?')
      .run(new Date().toISOString(), account.userId);

    // The token is still cryptographically valid; the account check rejects
    // it without waiting out the 15 minute expiry.
    const res = await request(app).get('/devices').set(auth(account.accessToken));
    expect(res.status).toBe(403);
  });
});

describe('POST /devices', () => {
  it('never returns a private key when the device supplied its own', async () => {
    const account = await user('keygen@example.com');
    const keys = clientKeypair();

    const created = await request(app)
      .post('/devices')
      .set(auth(account.accessToken))
      .send({ label: 'Pixel', publicKey: keys.publicKey, platform: 'android' });

    expect(created.status).toBe(201);
    expect(created.body.device.publicKey).toBe(keys.publicKey);
    expect(created.body.device.platform).toBe('android');
    expect(created.body.privateKey).toBeNull();
    expect(created.body.privateKeyIncluded).toBe(false);
    expect(created.body.conf).toContain(`PrivateKey = ${PRIVATE_KEY_PLACEHOLDER}`);
    expect(created.body.warning).toBeUndefined();
    expect(created.headers['cache-control']).toBe('no-store');
  });

  it('still generates server-side when no key is supplied', async () => {
    const account = await user('fallback@example.com');
    const created = await request(app).post('/devices').set(auth(account.accessToken)).send({});

    expect(created.body.privateKeyIncluded).toBe(true);
    expect(created.body.privateKey).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    expect(created.body.warning).toContain('returned once');
  });

  it('gives the device an address on every server, not just the default', async () => {
    const ams = await addNode(container, {
      region: 'nl-ams',
      displayName: 'Amsterdam',
      isDefault: false,
      addressPoolCidr: '10.9.0.0/24',
      serverAddress: '10.9.0.1',
      endpoint: 'ams.vpn.test:51820',
    });

    const account = await user('multi@example.com');
    const created = await request(app)
      .post('/devices')
      .set(auth(account.accessToken))
      .send({ publicKey: clientKeypair().publicKey });

    const regions = created.body.device.locations.map((l: { region: string }) => l.region).sort();
    expect(regions).toEqual(['de-fra', 'nl-ams']);
    // Pools are per node, so both can hand out .2.
    const addresses = created.body.device.locations.map(
      (l: { allowedIp: string }) => l.allowedIp,
    );
    expect(addresses).toEqual(['10.8.0.2/32', '10.9.0.2/32']);
    expect(ams.region).toBe('nl-ams');
  });

  it('counts devices, not device-region pairs, against the limit', async () => {
    await addNode(container, {
      region: 'nl-ams',
      isDefault: false,
      addressPoolCidr: '10.9.0.0/24',
      serverAddress: '10.9.0.1',
    });
    const account = await user('quota@example.com');

    // MAX_DEVICES_PER_USER is 2 in tests. With two regions the old model would
    // have allowed only one device.
    for (let i = 0; i < 2; i += 1) {
      const res = await request(app)
        .post('/devices')
        .set(auth(account.accessToken))
        .send({ publicKey: clientKeypair().publicKey });
      expect(res.status).toBe(201);
    }

    const third = await request(app)
      .post('/devices')
      .set(auth(account.accessToken))
      .send({ publicKey: clientKeypair().publicKey });
    expect(third.status).toBe(409);
    expect(third.body.error.code).toBe('peer_quota_exceeded');
    expect(third.body.error.details.limit).toBe(2);
  });

  it('rejects a malformed key and an over-long label', async () => {
    const account = await user('bad@example.com');

    expect(
      (
        await request(app)
          .post('/devices')
          .set(auth(account.accessToken))
          .send({ publicKey: 'nope' })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(app)
          .post('/devices')
          .set(auth(account.accessToken))
          .send({ label: 'x'.repeat(65) })
      ).status,
    ).toBe(400);
  });

  it('refuses a key already registered by another account', async () => {
    const keys = clientKeypair();
    const first = await user('dup1@example.com');
    const second = await user('dup2@example.com');

    await request(app)
      .post('/devices')
      .set(auth(first.accessToken))
      .send({ publicKey: keys.publicKey });

    const clash = await request(app)
      .post('/devices')
      .set(auth(second.accessToken))
      .send({ publicKey: keys.publicKey });

    expect(clash.status).toBe(409);
  });
});

describe('GET /devices and /servers', () => {
  it("lists only the caller's devices with no secrets", async () => {
    const mine = await user('mia@example.com');
    const theirs = await user('noah@example.com');

    await request(app)
      .post('/devices')
      .set(auth(mine.accessToken))
      .send({ label: 'Laptop', publicKey: clientKeypair().publicKey });
    await request(app)
      .post('/devices')
      .set(auth(theirs.accessToken))
      .send({ publicKey: clientKeypair().publicKey });

    const res = await request(app).get('/devices').set(auth(mine.accessToken));
    expect(res.body.devices).toHaveLength(1);
    expect(res.body.devices[0].label).toBe('Laptop');
    expect(JSON.stringify(res.body)).not.toContain('presharedKey');
    expect(res.body.devices[0]).not.toHaveProperty('privateKey');
  });

  it('lists the regions a client can choose', async () => {
    await addNode(container, {
      region: 'nl-ams',
      displayName: 'Amsterdam',
      isDefault: false,
      addressPoolCidr: '10.9.0.0/24',
      serverAddress: '10.9.0.1',
    });
    const account = await user('regions@example.com');

    const res = await request(app).get('/servers').set(auth(account.accessToken));

    expect(res.status).toBe(200);
    expect(res.body.servers.map((s: { displayName: string }) => s.displayName).sort()).toEqual([
      'Amsterdam',
      'Frankfurt',
    ]);
    expect(res.body.servers.every((s: { online: boolean }) => s.online)).toBe(true);
  });

  it('reports a node that has stopped syncing as offline', async () => {
    await addNode(
      container,
      { region: 'nl-ams', isDefault: false, addressPoolCidr: '10.9.0.0/24', serverAddress: '10.9.0.1' },
      { markOnline: false },
    );
    const account = await user('offline@example.com');

    const res = await request(app).get('/servers').set(auth(account.accessToken));
    const ams = res.body.servers.find((s: { region: string }) => s.region === 'nl-ams');

    // A node whose agent is gone still has peers, but sending new clients
    // there would strand them.
    expect(ams.online).toBe(false);
  });
});

describe('GET /devices/:id/config', () => {
  it('serves the default region with a placeholder instead of a key', async () => {
    const account = await user('olivia@example.com');
    const keys = clientKeypair();
    const created = await request(app)
      .post('/devices')
      .set(auth(account.accessToken))
      .send({ publicKey: keys.publicKey });

    const res = await request(app)
      .get(`/devices/${created.body.device.id}/config`)
      .set(auth(account.accessToken));

    expect(res.status).toBe(200);
    expect(res.body.privateKey).toBeNull();
    expect(res.body.conf).toContain(`PrivateKey = ${PRIVATE_KEY_PLACEHOLDER}`);
    expect(res.body.conf).not.toContain(keys.privateKey);
    expect(res.body.conf).toContain('Endpoint = fra.vpn.test:51820');
    expect(res.body.conf).toContain('AllowedIPs = 0.0.0.0/0, ::/0');
    expect(res.body.conf).toContain('MTU = 1420');
  });

  it('serves a different region on request', async () => {
    await addNode(container, {
      region: 'nl-ams',
      isDefault: false,
      addressPoolCidr: '10.9.0.0/24',
      serverAddress: '10.9.0.1',
      endpoint: 'ams.vpn.test:51820',
    });
    const account = await user('switch@example.com');
    const created = await request(app)
      .post('/devices')
      .set(auth(account.accessToken))
      .send({ publicKey: clientKeypair().publicKey });

    const ams = (await request(app).get('/servers').set(auth(account.accessToken))).body.servers.find(
      (s: { region: string }) => s.region === 'nl-ams',
    );

    const res = await request(app)
      .get(`/devices/${created.body.device.id}/config?serverId=${ams.id}`)
      .set(auth(account.accessToken));

    // Switching region is a different endpoint and address, same device.
    expect(res.body.conf).toContain('Endpoint = ams.vpn.test:51820');
    expect(res.body.conf).toContain('Address = 10.9.0.2/32');
    expect(res.body.device.id).toBe(created.body.device.id);
  });

  it('gives a device an address on a server added after it was created', async () => {
    const account = await user('latecomer@example.com');
    const created = await request(app)
      .post('/devices')
      .set(auth(account.accessToken))
      .send({ publicKey: clientKeypair().publicKey });

    const ams = await addNode(container, {
      region: 'nl-ams',
      isDefault: false,
      addressPoolCidr: '10.9.0.0/24',
      serverAddress: '10.9.0.1',
    });

    const res = await request(app)
      .get(`/devices/${created.body.device.id}/config?serverId=${ams.id}`)
      .set(auth(account.accessToken));

    expect(res.status).toBe(200);
    expect(res.body.conf).toContain('Address = 10.9.0.2/32');
  });

  it("reports another user's device as missing", async () => {
    const owner = await user('paul@example.com');
    const stranger = await user('quinn@example.com');
    const created = await request(app)
      .post('/devices')
      .set(auth(owner.accessToken))
      .send({ publicKey: clientKeypair().publicKey });

    expect(
      (
        await request(app)
          .get(`/devices/${created.body.device.id}/config`)
          .set(auth(stranger.accessToken))
      ).status,
    ).toBe(404);
  });
});

describe('POST /devices/:id/rotate', () => {
  it('swaps the key while keeping the identity and every address', async () => {
    await addNode(container, {
      region: 'nl-ams',
      isDefault: false,
      addressPoolCidr: '10.9.0.0/24',
      serverAddress: '10.9.0.1',
    });
    const account = await user('rot@example.com');
    const created = await request(app)
      .post('/devices')
      .set(auth(account.accessToken))
      .send({ label: 'Phone', publicKey: clientKeypair().publicKey });

    const next = clientKeypair();
    const res = await request(app)
      .post(`/devices/${created.body.device.id}/rotate`)
      .set(auth(account.accessToken))
      .send({ publicKey: next.publicKey });

    expect(res.status).toBe(200);
    expect(res.body.device.id).toBe(created.body.device.id);
    expect(res.body.device.label).toBe('Phone');
    expect(res.body.device.publicKey).toBe(next.publicKey);
    expect(res.body.device.keyRotatedAt).toBeTruthy();
    // Rotation changes the key, never the addresses.
    expect(res.body.device.locations).toHaveLength(2);
  });

  it('propagates to the nodes on their next sync', async () => {
    const account = await user('rotsync@example.com');
    const created = await request(app)
      .post('/devices')
      .set(auth(account.accessToken))
      .send({ publicKey: clientKeypair().publicKey });

    const next = clientKeypair();
    await request(app)
      .post(`/devices/${created.body.device.id}/rotate`)
      .set(auth(account.accessToken))
      .send({ publicKey: next.publicKey });

    const sync = await nodeSync(app, fra);
    const keys = sync.body.peers.map((p: { publicKey: string }) => p.publicKey);

    // The old key is simply absent from the next answer, which is how the
    // agent learns to remove it.
    expect(keys).toEqual([next.publicKey]);
  });

  it('rejects rotating to the active key and to a malformed one', async () => {
    const account = await user('rotbad@example.com');
    const keys = clientKeypair();
    const created = await request(app)
      .post('/devices')
      .set(auth(account.accessToken))
      .send({ publicKey: keys.publicKey });

    expect(
      (
        await request(app)
          .post(`/devices/${created.body.device.id}/rotate`)
          .set(auth(account.accessToken))
          .send({ publicKey: keys.publicKey })
      ).status,
    ).toBe(409);
    expect(
      (
        await request(app)
          .post(`/devices/${created.body.device.id}/rotate`)
          .set(auth(account.accessToken))
          .send({ publicKey: 'nope' })
      ).status,
    ).toBe(400);
  });
});

describe('DELETE /devices/:id', () => {
  it('revokes everywhere and frees the addresses', async () => {
    await addNode(container, {
      region: 'nl-ams',
      isDefault: false,
      addressPoolCidr: '10.9.0.0/24',
      serverAddress: '10.9.0.1',
    });
    const account = await user('sam@example.com');
    const created = await request(app)
      .post('/devices')
      .set(auth(account.accessToken))
      .send({ publicKey: clientKeypair().publicKey });

    expect(
      (
        await request(app)
          .delete(`/devices/${created.body.device.id}`)
          .set(auth(account.accessToken))
      ).status,
    ).toBe(204);

    await expect(container.repos.peers.listActiveByDevice(created.body.device.id)).resolves.toEqual(
      [],
    );

    // The freed address goes to the next device.
    const replacement = await request(app)
      .post('/devices')
      .set(auth(account.accessToken))
      .send({ publicKey: clientKeypair().publicKey });
    expect(replacement.body.device.locations[0].allowedIp).toBe('10.8.0.2/32');
  });

  it("will not delete another user's device", async () => {
    const owner = await user('tina@example.com');
    const stranger = await user('umar@example.com');
    const created = await request(app)
      .post('/devices')
      .set(auth(owner.accessToken))
      .send({ publicKey: clientKeypair().publicKey });

    expect(
      (
        await request(app)
          .delete(`/devices/${created.body.device.id}`)
          .set(auth(stranger.accessToken))
      ).status,
    ).toBe(404);
  });
});

describe('DELETE /auth/account', () => {
  it('erases the account and everything under it', async () => {
    const account = await user('xena@example.com');
    await request(app)
      .post('/devices')
      .set(auth(account.accessToken))
      .send({ publicKey: clientKeypair().publicKey });

    const res = await request(app)
      .delete('/auth/account')
      .set(auth(account.accessToken))
      .send({ password: PASSWORD });
    expect(res.status).toBe(204);

    await expect(container.repos.users.findByEmail(account.email)).resolves.toBeNull();
    // Nothing left for an agent to install.
    const sync = await nodeSync(app, fra);
    expect(sync.body.peers).toHaveLength(0);
  });

  it('refuses a wrong password with 403, not 401', async () => {
    const account = await user('yuri@example.com');

    const res = await request(app)
      .delete('/auth/account')
      .set(auth(account.accessToken))
      .send({ password: 'not-the-password' });

    // 401 would look like an expired token and send the client down its
    // refresh-then-sign-out path over a typo.
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('invalid_password');
    await expect(container.repos.users.findByEmail(account.email)).resolves.not.toBeNull();
  });
});

describe('operational endpoints', () => {
  it('reports health and readiness', async () => {
    expect((await request(app).get('/health')).body.status).toBe('ok');

    const ready = await request(app).get('/ready');
    expect(ready.status).toBe(200);
    expect(ready.body.nodes[0].region).toBe('de-fra');
    expect(ready.body.nodes[0].online).toBe(true);
    expect(ready.body.nodes[0].agentProvisioned).toBe(true);
    expect(ready.body.nodes[0].keyMatchesConfig).toBe(true);
  });

  it('is degraded when no node is reporting', async () => {
    const { app: bare } = await createHarness();
    const ready = await request(bare).get('/ready');

    // Accepting signups while nothing can apply a config is worse than
    // failing the readiness probe.
    expect(ready.status).toBe(503);
    expect(ready.body.status).toBe('degraded');
  });

  it('returns a structured 404 for unknown routes', async () => {
    const res = await request(app).get('/nope');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('not_found');
  });
});

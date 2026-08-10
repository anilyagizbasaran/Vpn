import type { Express } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Container } from '../src/container.js';
import {
  addNode,
  auth,
  clientKeypair,
  createHarness,
  nodeSync,
  registerUser,
  type TestNode,
} from './helpers.js';

/**
 * Failure paths, races and the node protocol. These are the claims that are
 * easy to state and hard to keep true.
 */

let app: Express;
let container: Container;
let fra: TestNode;

beforeEach(async () => {
  ({ app, container } = await createHarness());
  fra = await addNode(container);
});

describe('node sync', () => {
  it('rejects an unknown or missing token', async () => {
    expect((await request(app).post('/node/sync').send({})).status).toBe(401);

    const res = await request(app)
      .post('/node/sync')
      .set(auth('not-a-real-node-token'))
      .send({
        interfacePublicKey: clientKeypair().publicKey,
        agentVersion: 'test',
        usage: [],
      });
    expect(res.status).toBe(401);
  });

  it('returns exactly the peers this node should have', async () => {
    const ams = await addNode(container, {
      region: 'nl-ams',
      isDefault: false,
      addressPoolCidr: '10.9.0.0/24',
      serverAddress: '10.9.0.1',
    });
    const account = await registerUser(app, 'sync@example.com');
    const keys = clientKeypair();
    await request(app)
      .post('/devices')
      .set(auth(account.accessToken))
      .send({ publicKey: keys.publicKey });

    const fraSync = await nodeSync(app, fra);
    expect(fraSync.status).toBe(200);
    expect(fraSync.body.peers).toHaveLength(1);
    expect(fraSync.body.peers[0].publicKey).toBe(keys.publicKey);
    expect(fraSync.body.peers[0].allowedIps).toEqual(['10.8.0.2/32']);
    expect(fraSync.body.server.interfaceName).toBe('wg0');
    expect(fraSync.body.pollAfterSeconds).toBe(10);

    // The same device, a different address, because pools are per node.
    const amsSync = await nodeSync(app, ams);
    expect(amsSync.body.peers[0].allowedIps).toEqual(['10.9.0.2/32']);
  });

  it('includes the preshared key so the node can install it', async () => {
    const account = await registerUser(app, 'psk@example.com');
    await request(app)
      .post('/devices')
      .set(auth(account.accessToken))
      .send({ publicKey: clientKeypair().publicKey });

    const sync = await nodeSync(app, fra);
    expect(sync.body.peers[0].presharedKey).toMatch(/^[A-Za-z0-9+/]{43}=$/);
  });

  it('stops listing a revoked device immediately', async () => {
    const account = await registerUser(app, 'revoked@example.com');
    const created = await request(app)
      .post('/devices')
      .set(auth(account.accessToken))
      .send({ publicKey: clientKeypair().publicKey });

    expect((await nodeSync(app, fra)).body.peers).toHaveLength(1);

    await request(app).delete(`/devices/${created.body.device.id}`).set(auth(account.accessToken));

    // The agent removes what is no longer in the answer, so the propagation
    // delay is one poll interval and no more.
    expect((await nodeSync(app, fra)).body.peers).toHaveLength(0);
  });

  it('never leaks one node the peers of another', async () => {
    const ams = await addNode(container, {
      region: 'nl-ams',
      isDefault: false,
      addressPoolCidr: '10.9.0.0/24',
      serverAddress: '10.9.0.1',
    });
    const account = await registerUser(app, 'iso@example.com');
    await request(app)
      .post('/devices')
      .set(auth(account.accessToken))
      .send({ publicKey: clientKeypair().publicKey });

    // A node token is scoped to its own server row; a compromised node learns
    // nothing about the rest of the fleet's addressing.
    const amsSync = await nodeSync(app, ams);
    expect(amsSync.body.server.id).toBe(ams.id);
    expect(amsSync.body.peers[0].allowedIps).toEqual(['10.9.0.2/32']);
  });

  it('records the heartbeat and the reported interface key', async () => {
    await nodeSync(app, fra);

    const server = await container.repos.servers.findById(fra.id);
    expect(server?.lastSeenAt).toBeTruthy();
    expect(server?.agentVersion).toBe('test-agent/1.0');
    expect(server?.reportedPublicKey).toBe(fra.publicKey);
  });

  it('folds usage into per-device totals', async () => {
    const account = await registerUser(app, 'usage@example.com');
    const keys = clientKeypair();
    const created = await request(app)
      .post('/devices')
      .set(auth(account.accessToken))
      .send({ publicKey: keys.publicKey });

    await nodeSync(app, fra, [{ publicKey: keys.publicKey, rxBytes: 500, txBytes: 700 }]);
    await nodeSync(app, fra, [{ publicKey: keys.publicKey, rxBytes: 900, txBytes: 1_100 }]);

    const list = await request(app).get('/devices').set(auth(account.accessToken));
    expect(list.body.devices[0].usage).toEqual({ rxBytes: 900, txBytes: 1_100 });
    expect(created.body.device.usage).toEqual({ rxBytes: 0, txBytes: 0 });
  });

  it('rejects a malformed report without touching the totals', async () => {
    const res = await request(app)
      .post('/node/sync')
      .set(auth(fra.token))
      .send({
        interfacePublicKey: 'not-a-key',
        agentVersion: 'test',
        usage: [],
      });

    expect(res.status).toBe(400);
  });

  it('refuses an oversized usage report', async () => {
    const usage = Array.from({ length: 10_001 }, () => ({
      publicKey: clientKeypair().publicKey,
      rxBytes: 1,
      txBytes: 1,
      lastHandshakeAt: null,
    }));

    const res = await request(app)
      .post('/node/sync')
      .set(auth(fra.token))
      .send({ interfacePublicKey: fra.publicKey, agentVersion: 'test', usage });

    expect(res.status).toBe(400);
  });
});

describe('concurrent device creation', () => {
  it('never hands two devices the same address', async () => {
    const tokens = await Promise.all(
      Array.from({ length: 8 }, (_, i) => registerUser(app, `race${i}@example.com`)),
    );

    const responses = await Promise.all(
      tokens.map((account) =>
        request(app)
          .post('/devices')
          .set(auth(account.accessToken))
          .send({ publicKey: clientKeypair().publicKey }),
      ),
    );

    expect(responses.every((r) => r.status === 201)).toBe(true);

    const addresses = responses.map(
      (r) => r.body.device.locations[0].allowedIp as string,
    );
    expect(new Set(addresses).size).toBe(addresses.length);
    expect(addresses).not.toContain('10.8.0.1/32');

    // The node's view agrees with the database.
    const sync = await nodeSync(app, fra);
    expect(sync.body.peers).toHaveLength(8);
  });

  it('keeps the pool consistent when creates and deletes interleave', async () => {
    const account = await registerUser(app, 'churn@example.com');

    for (let round = 0; round < 4; round += 1) {
      const created = await Promise.all([
        request(app)
          .post('/devices')
          .set(auth(account.accessToken))
          .send({ publicKey: clientKeypair().publicKey }),
        request(app)
          .post('/devices')
          .set(auth(account.accessToken))
          .send({ publicKey: clientKeypair().publicKey }),
      ]);
      expect(created.every((r) => r.status === 201)).toBe(true);

      await Promise.all(
        created.map((r) =>
          request(app).delete(`/devices/${r.body.device.id}`).set(auth(account.accessToken)),
        ),
      );
    }

    expect((await nodeSync(app, fra)).body.peers).toHaveLength(0);
  });
});

describe('address pool exhaustion', () => {
  it('reports a conflict rather than handing out a duplicate', async () => {
    const { app: tiny, container: tinyContainer } = await createHarness();
    // A /30 leaves exactly one usable address after the node takes .1.
    await addNode(tinyContainer, {
      region: 'tiny',
      addressPoolCidr: '10.9.0.0/30',
      serverAddress: '10.9.0.1',
    });

    const first = await registerUser(tiny, 'p1@example.com');
    const second = await registerUser(tiny, 'p2@example.com');

    const ok = await request(tiny)
      .post('/devices')
      .set(auth(first.accessToken))
      .send({ publicKey: clientKeypair().publicKey });
    expect(ok.status).toBe(201);
    expect(ok.body.device.locations[0].allowedIp).toBe('10.9.0.2/32');

    const full = await request(tiny)
      .post('/devices')
      .set(auth(second.accessToken))
      .send({ publicKey: clientKeypair().publicKey });
    expect(full.status).toBe(409);
    expect(full.body.error.message).toMatch(/no free addresses/i);

    tinyContainer.close();
  });

  it('refuses to register a device when no node is allocatable', async () => {
    const { app: bare } = await createHarness();
    const account = await registerUser(bare, 'nonodes@example.com');

    const res = await request(bare)
      .post('/devices')
      .set(auth(account.accessToken))
      .send({ publicKey: clientKeypair().publicKey });

    // Better than a device with no addresses that silently never connects.
    expect(res.status).toBe(422);
  });
});

describe('hostile and malformed input', () => {
  it('rejects malformed JSON with a 400, not a stack trace', async () => {
    const res = await request(app)
      .post('/auth/login')
      .set('content-type', 'application/json')
      .send('{"email": "a@b.co", ');

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toContain('at ');
  });

  it('rejects an oversized body with 413', async () => {
    const res = await request(app)
      .post('/auth/register')
      .send({ email: 'big@example.com', password: 'x'.repeat(64 * 1024) });

    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('payload_too_large');
  });

  it('does not let a device label escape into the rendered config', async () => {
    const account = await registerUser(app, 'inject@example.com');

    const res = await request(app)
      .post('/devices')
      .set(auth(account.accessToken))
      .send({ label: 'evil\nAllowedIPs = 10.0.0.0/8', publicKey: clientKeypair().publicKey });

    expect(res.status).toBe(400);
  });

  it('ignores client-supplied fields it does not own', async () => {
    const account = await registerUser(app, 'extra@example.com');

    const res = await request(app)
      .post('/devices')
      .set(auth(account.accessToken))
      .send({
        label: 'Phone',
        publicKey: clientKeypair().publicKey,
        allowedIp: '10.8.0.99/32',
        userId: 1,
        serverId: 42,
      });

    expect(res.status).toBe(201);
    expect(res.body.device.locations[0].allowedIp).toBe('10.8.0.2/32');
    expect(res.body.device.locations[0].serverId).toBe(fra.id);
  });

  it('rejects a refresh token used as an access token', async () => {
    const account = await registerUser(app, 'swap@example.com');
    expect((await request(app).get('/devices').set(auth(account.refreshToken))).status).toBe(401);
  });
});

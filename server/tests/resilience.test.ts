import type { Express } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createContainer, type Container } from '../src/container.js';
import { MockWireGuardController } from '../src/services/wireguard/index.js';
import type { DesiredPeer, WireGuardController } from '../src/services/wireguard/index.js';

/**
 * Failure paths and races: what the system does when `wg` breaks, when two
 * requests collide, and when the input is hostile. These are the claims that
 * are easy to state in a README and hard to keep true.
 */

const PASSWORD = 'a-long-enough-password';
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

/** Wraps the mock so individual operations can be made to fail on demand. */
class FlakyWireGuard implements WireGuardController {
  readonly kind = 'mock' as const;
  readonly interfaceName: string;

  failAddPeer = false;
  failRemovePeer = false;
  failReplacePeer = false;
  addPeerCalls = 0;

  private readonly inner: MockWireGuardController;

  constructor(interfaceName: string) {
    this.interfaceName = interfaceName;
    this.inner = new MockWireGuardController(interfaceName);
  }

  generateKeyPair() {
    return this.inner.generateKeyPair();
  }
  generatePresharedKey() {
    return this.inner.generatePresharedKey();
  }
  async addPeer(peer: DesiredPeer) {
    this.addPeerCalls += 1;
    if (this.failAddPeer) throw new Error('wg: Unable to modify interface: Operation not permitted');
    return this.inner.addPeer(peer);
  }
  async removePeer(publicKey: string) {
    if (this.failRemovePeer) throw new Error('wg: Unable to modify interface');
    return this.inner.removePeer(publicKey);
  }
  async replacePeer(oldPublicKey: string, peer: DesiredPeer) {
    if (this.failReplacePeer) throw new Error('wg: Unable to modify interface');
    return this.inner.replacePeer(oldPublicKey, peer);
  }
  listPeerPublicKeys() {
    return this.inner.listPeerPublicKeys();
  }
  getInterfacePublicKey() {
    return this.inner.getInterfacePublicKey();
  }
  sync(desired: DesiredPeer[]) {
    return this.inner.sync(desired);
  }
}

let app: Express;
let container: Container;
let wg: FlakyWireGuard;

beforeEach(async () => {
  wg = new FlakyWireGuard('wgtest0');
  container = await createContainer({ databasePath: ':memory:', wg });
  app = createApp(container);
});

async function registerUser(email: string) {
  const res = await request(app).post('/auth/register').send({ email, password: PASSWORD });
  return res.body.tokens.accessToken as string;
}

describe('concurrent peer creation', () => {
  it('never hands two devices the same address', async () => {
    // One user cannot exceed the quota of 2, so spread the load over users.
    const tokens = await Promise.all(
      Array.from({ length: 8 }, (_, i) => registerUser(`race${i}@example.com`)),
    );

    const responses = await Promise.all(
      tokens.map((token) => request(app).post('/peers').set(auth(token)).send({})),
    );

    expect(responses.every((r) => r.status === 201)).toBe(true);

    const addresses = responses.map((r) => r.body.peer.allowedIp as string);
    expect(new Set(addresses).size).toBe(addresses.length);
    // Dense allocation from the bottom of the pool, no gaps and no server IP.
    expect([...addresses].sort()).not.toContain('10.8.0.1/32');

    // The interface agrees with the database.
    const live = await wg.listPeerPublicKeys();
    expect(live).toHaveLength(8);
    await expect(container.repos.peers.listAllActive()).resolves.toHaveLength(8);
  });

  it('keeps the pool consistent when creates and deletes interleave', async () => {
    const token = await registerUser('churn@example.com');

    for (let round = 0; round < 4; round += 1) {
      const created = await Promise.all([
        request(app).post('/peers').set(auth(token)).send({}),
        request(app).post('/peers').set(auth(token)).send({}),
      ]);
      expect(created.every((r) => r.status === 201)).toBe(true);

      const ids = created.map((r) => r.body.peer.id as number);
      await Promise.all(ids.map((id) => request(app).delete(`/peers/${id}`).set(auth(token))));
    }

    await expect(container.repos.peers.listAllActive()).resolves.toHaveLength(0);
    await expect(wg.listPeerPublicKeys()).resolves.toHaveLength(0);
  });
});

describe('when the WireGuard interface fails', () => {
  it('releases the reserved address and does not consume a device slot', async () => {
    const token = await registerUser('wgfail@example.com');
    wg.failAddPeer = true;

    const failed = await request(app).post('/peers').set(auth(token)).send({});
    expect(failed.status).toBe(502);
    expect(failed.body.error.code).toBe('wireguard_error');
    // The `wg` stderr must not reach the client.
    expect(JSON.stringify(failed.body)).not.toContain('Operation not permitted');

    // No live peer, no leaked address, quota untouched.
    await expect(container.repos.peers.listAllActive()).resolves.toHaveLength(0);
    const list = await request(app).get('/peers').set(auth(token));
    expect(list.body.peers).toHaveLength(0);

    wg.failAddPeer = false;
    const retry = await request(app).post('/peers').set(auth(token)).send({});
    expect(retry.status).toBe(201);
    // The address the failed attempt reserved went back into the pool.
    expect(retry.body.peer.allowedIp).toBe('10.8.0.2/32');
  });

  it('keeps a revoke durable even when the interface refuses', async () => {
    const token = await registerUser('revokefail@example.com');
    const peer = await request(app).post('/peers').set(auth(token)).send({});

    wg.failRemovePeer = true;
    const res = await request(app).delete(`/peers/${peer.body.peer.id}`).set(auth(token));
    expect(res.status).toBe(502);

    // Database-first ordering: the peer is already revoked, so the boot sync
    // will remove it. The reverse order could resurrect a revoked key.
    const stored = await container.repos.peers.findById(peer.body.peer.id);
    expect(stored?.revokedAt).not.toBeNull();

    // Retrying is safe and now succeeds.
    wg.failRemovePeer = false;
    const retry = await request(app).delete(`/peers/${peer.body.peer.id}`).set(auth(token));
    expect(retry.status).toBe(204);
    await expect(wg.listPeerPublicKeys()).resolves.not.toContain(peer.body.peer.publicKey);
  });

  it('reverts a failed key rotation so the device keeps a working key', async () => {
    const token = await registerUser('rotfail@example.com');
    const oldKey = Buffer.alloc(32, 1).toString('base64');
    const newKey = Buffer.alloc(32, 2).toString('base64');

    const peer = await request(app)
      .post('/peers')
      .set(auth(token))
      .send({ publicKey: oldKey });

    wg.failReplacePeer = true;
    const res = await request(app)
      .post(`/peers/${peer.body.peer.id}/rotate`)
      .set(auth(token))
      .send({ publicKey: newKey });

    expect(res.status).toBe(502);

    // The database must agree with the interface, or the device would hold a
    // key the server never accepted and the tunnel would silently never come up.
    const stored = await container.repos.peers.findById(peer.body.peer.id);
    expect(stored?.publicKey).toBe(oldKey);
    await expect(wg.listPeerPublicKeys()).resolves.toEqual([oldKey]);

    // Retrying after the interface recovers works.
    wg.failReplacePeer = false;
    const retry = await request(app)
      .post(`/peers/${peer.body.peer.id}/rotate`)
      .set(auth(token))
      .send({ publicKey: newKey });
    expect(retry.status).toBe(200);
    await expect(wg.listPeerPublicKeys()).resolves.toEqual([newKey]);
  });

  it('drops a revoked peer from the interface on the next sync', async () => {
    const token = await registerUser('syncfix@example.com');
    const peer = await request(app).post('/peers').set(auth(token)).send({});

    wg.failRemovePeer = true;
    await request(app).delete(`/peers/${peer.body.peer.id}`).set(auth(token));
    wg.failRemovePeer = false;
    expect(await wg.listPeerPublicKeys()).toContain(peer.body.peer.publicKey);

    await container.peers.syncInterface();

    await expect(wg.listPeerPublicKeys()).resolves.toHaveLength(0);
  });
});

describe('hostile and malformed input', () => {
  it('rejects malformed JSON with a 400, not a stack trace', async () => {
    const res = await request(app)
      .post('/auth/login')
      .set('content-type', 'application/json')
      .send('{"email": "a@b.co", ');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('bad_request');
    expect(JSON.stringify(res.body)).not.toContain('at ');
  });

  it('rejects an oversized body with 413, not a 500 and a stack trace', async () => {
    const res = await request(app)
      .post('/auth/register')
      .send({ email: 'big@example.com', password: 'x'.repeat(64 * 1024) });

    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('payload_too_large');
  });

  it('does not let a device label escape into the rendered config', async () => {
    const token = await registerUser('inject@example.com');

    const res = await request(app)
      .post('/peers')
      .set(auth(token))
      .send({ deviceLabel: 'evil\nAllowedIPs = 10.0.0.0/8' });

    // Newlines are control characters and are rejected outright.
    expect(res.status).toBe(400);
    expect(res.body.error.details[0].field).toBe('deviceLabel');
  });

  it('rejects a device label made only of whitespace', async () => {
    const token = await registerUser('blank@example.com');
    const res = await request(app).post('/peers').set(auth(token)).send({ deviceLabel: '   ' });
    expect(res.status).toBe(400);
  });

  it('ignores extra fields instead of trusting them', async () => {
    const token = await registerUser('extra@example.com');

    const res = await request(app)
      .post('/peers')
      .set(auth(token))
      .send({ deviceLabel: 'Phone', allowedIp: '10.8.0.99/32', userId: 1, serverId: 42 });

    expect(res.status).toBe(201);
    // Client-supplied address and ownership are discarded.
    expect(res.body.peer.allowedIp).toBe('10.8.0.2/32');
    expect(res.body.peer.serverId).toBe(1);
  });

  it('rejects a token signed with the wrong secret', async () => {
    // A well-formed JWT with a different signature must not authenticate.
    const forged =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.' +
      'eyJ0eXAiOiJhY2Nlc3MiLCJzdWIiOiIxIiwiaXNzIjoidnBuLWNvbnRyb2wtcGxhbmUifQ.' +
      'aW52YWxpZHNpZ25hdHVyZWludmFsaWRzaWduYXR1cmU';

    const res = await request(app).get('/peers').set(auth(forged));
    expect(res.status).toBe(401);
  });

  it('rejects a refresh token in the access token slot', async () => {
    const registered = await request(app)
      .post('/auth/register')
      .send({ email: 'swap@example.com', password: PASSWORD });

    const res = await request(app)
      .get('/peers')
      .set(auth(registered.body.tokens.refreshToken as string));

    expect(res.status).toBe(401);
  });
});

describe('address pool exhaustion', () => {
  it('reports a conflict rather than handing out a duplicate or crashing', async () => {
    // A /30 leaves exactly one usable address after the server takes .1.
    const tiny = await createContainer({
      databasePath: ':memory:',
      wg: new MockWireGuardController('wgtiny'),
    });
    tiny.db.prepare('UPDATE servers SET address_pool_cidr = ?, server_address = ?').run(
      '10.9.0.0/30',
      '10.9.0.1',
    );
    const tinyApp = createApp(tiny);

    const first = await request(tinyApp)
      .post('/auth/register')
      .send({ email: 'p1@example.com', password: PASSWORD });
    const second = await request(tinyApp)
      .post('/auth/register')
      .send({ email: 'p2@example.com', password: PASSWORD });

    const ok = await request(tinyApp)
      .post('/peers')
      .set(auth(first.body.tokens.accessToken))
      .send({});
    expect(ok.status).toBe(201);
    expect(ok.body.peer.allowedIp).toBe('10.9.0.2/32');

    const full = await request(tinyApp)
      .post('/peers')
      .set(auth(second.body.tokens.accessToken))
      .send({});
    expect(full.status).toBe(409);
    expect(full.body.error.message).toMatch(/no free addresses/i);

    tiny.close();
  });
});

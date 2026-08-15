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
  enrolDevice,
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
    const device = await enrolDevice(app, container);

    const fraSync = await nodeSync(app, fra);
    expect(fraSync.status).toBe(200);
    expect(fraSync.body.peers).toHaveLength(1);
    expect(fraSync.body.peers[0].publicKey).toBe(device.publicKey);
    expect(fraSync.body.peers[0].allowedIps).toEqual(['10.8.0.2/32']);
    expect(fraSync.body.server.interfaceName).toBe('wg0');
    expect(fraSync.body.pollAfterSeconds).toBe(10);

    // The same device, a different address, because pools are per node.
    const amsSync = await nodeSync(app, ams);
    expect(amsSync.body.peers[0].allowedIps).toEqual(['10.9.0.2/32']);
  });

  it('includes the preshared key so the node can install it', async () => {
    await enrolDevice(app, container);

    const sync = await nodeSync(app, fra);
    expect(sync.body.peers[0].presharedKey).toMatch(/^[A-Za-z0-9+/]{43}=$/);
  });

  it('stops listing a revoked device immediately', async () => {
    const device = await enrolDevice(app, container);

    expect((await nodeSync(app, fra)).body.peers).toHaveLength(1);

    await request(app).delete('/device').set(auth(device.deviceToken)).expect(204);

    // The agent removes what is no longer in the answer, so the propagation
    // delay is one poll interval and no more.
    expect((await nodeSync(app, fra)).body.peers).toHaveLength(0);
  });

  it('drops every device of a rotated code, not just the code', async () => {
    const device = await enrolDevice(app, container);
    expect((await nodeSync(app, fra)).body.peers).toHaveLength(1);

    // Rotating alone stops further enrolment and nothing else. The device
    // holds its own token and stays on the interface, so an operator who
    // thought they had cut off a leaked code would still be carrying the
    // traffic. Both halves have to run — which is what `vpn reset --kick` is.
    const invite = (await container.repos.invites.list())[0]!;
    await container.invites.rotate(invite.id);
    expect((await nodeSync(app, fra)).body.peers).toHaveLength(1);

    const removed = await container.devices.revokeAllForInvite(invite.id);

    expect(removed).toBe(1);
    expect((await nodeSync(app, fra)).body.peers).toHaveLength(0);
    // ...and the device's own token stops working the moment it is used.
    expect((await request(app).get('/device').set(auth(device.deviceToken))).status).toBe(401);
  });

  it('returns a revoked device address to the pool', async () => {
    const { inviteToken } = await enrolDevice(app, container);
    const invite = (await container.repos.invites.list())[0]!;

    await container.devices.revokeAllForInvite(invite.id);

    // The address it held was the lowest free one, so the next enrolment gets
    // it straight back. Without this a long-lived server slowly runs out of
    // pool as devices come and go.
    const next = await request(app)
      .post('/enroll')
      .send({ inviteToken, publicKey: clientKeypair().publicKey })
      .expect(201);
    expect(next.body.device.locations[0].allowedIp).toBe('10.8.0.2/32');
  });

  it('never leaks one node the peers of another', async () => {
    const ams = await addNode(container, {
      region: 'nl-ams',
      isDefault: false,
      addressPoolCidr: '10.9.0.0/24',
      serverAddress: '10.9.0.1',
    });
    await enrolDevice(app, container);

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

  it('rejects a malformed interface key', async () => {
    const res = await request(app)
      .post('/node/sync')
      .set(auth(fra.token))
      .send({
        interfacePublicKey: 'not-a-key',
        agentVersion: 'test',
      });

    expect(res.status).toBe(400);
  });

});

describe('concurrent device creation', () => {
  it('never hands two devices the same address', async () => {
    const { token: invite } = await container.invites.mint({ deviceLimit: 8,
    });

    // Eight enrolments at once against one pool. The partial unique index is
    // the arbiter, not application logic, and the loser of a race retries.
    const responses = await Promise.all(
      Array.from({ length: 8 }, () =>
        request(app)
          .post('/enroll')
          .send({ inviteToken: invite, publicKey: clientKeypair().publicKey }),
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
    const { token: invite } = await container.invites.mint({ deviceLimit: 5,
    });

    for (let round = 0; round < 4; round += 1) {
      const created = await Promise.all([
        request(app)
          .post('/enroll')
          .send({ inviteToken: invite, publicKey: clientKeypair().publicKey }),
        request(app)
          .post('/enroll')
          .send({ inviteToken: invite, publicKey: clientKeypair().publicKey }),
      ]);
      expect(created.every((r) => r.status === 201)).toBe(true);

      // Each device removes itself with its own token — there is no other way
      // to name it, which is the point.
      await Promise.all(
        created.map((r) =>
          request(app).delete('/device').set(auth(r.body.deviceToken as string)),
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

    const { token: invite } = await tinyContainer.invites.mint({ deviceLimit: 5,
    });

    const ok = await request(tiny)
      .post('/enroll')
      .send({ inviteToken: invite, publicKey: clientKeypair().publicKey });
    expect(ok.status).toBe(201);
    expect(ok.body.device.locations[0].allowedIp).toBe('10.9.0.2/32');

    const full = await request(tiny)
      .post('/enroll')
      .send({ inviteToken: invite, publicKey: clientKeypair().publicKey });
    expect(full.status).toBe(409);
    expect(full.body.error.message).toMatch(/no free addresses/i);

    tinyContainer.close();
  });

  it('refuses to register a device when no node is allocatable', async () => {
    const { app: bare, container: bareContainer } = await createHarness();
    const { token: invite } = await bareContainer.invites.mint({ deviceLimit: 5,
    });

    const res = await request(bare)
      .post('/enroll')
      .send({ inviteToken: invite, publicKey: clientKeypair().publicKey });

    // Better than a device with no addresses that silently never connects.
    expect(res.status).toBe(422);
  });
});

describe('hostile and malformed input', () => {
  it('rejects malformed JSON with a 400, not a stack trace', async () => {
    const res = await request(app)
      .post('/enroll')
      .set('content-type', 'application/json')
      .send('{"inviteToken": "x", ');

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toContain('at ');
  });

  it('rejects an oversized body with 413', async () => {
    const res = await request(app)
      .post('/enroll')
      .send({ inviteToken: 'x', label: 'x'.repeat(64 * 1024) });

    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('payload_too_large');
  });

  it('has no label to escape into the rendered config', async () => {
    const device = await enrolDevice(app, container);

    // This used to be a validation test: a label with a newline in it would
    // otherwise reach the wg-quick config, where a line of its own is a
    // directive. The label is not stored at all now, so the injection has
    // nowhere to land — the field is accepted and thrown away.
    const hostile = 'evil\nAllowedIPs = 10.0.0.0/8';
    const res = await request(app).post('/enroll').send({
      inviteToken: device.inviteToken,
      label: hostile,
      publicKey: clientKeypair().publicKey,
    });

    expect(res.status).toBe(201);
    expect(res.body.conf).not.toContain('10.0.0.0/8');
    expect(JSON.stringify(res.body)).not.toContain('evil');
  });

  it('ignores client-supplied fields it does not own', async () => {
    const { token: invite } = await container.invites.mint({ deviceLimit: 5 });

    const res = await request(app)
      .post('/enroll')
      .send({
        inviteToken: invite,
        publicKey: clientKeypair().publicKey,
        allowedIp: '10.8.0.99/32',
        userId: 1,
        serverId: 42,
      });

    expect(res.status).toBe(201);
    expect(res.body.device.locations[0].allowedIp).toBe('10.8.0.2/32');
    expect(res.body.device.locations[0].serverId).toBe(fra.id);
  });

  it('refuses an invite code presented as a device token', async () => {
    const device = await enrolDevice(app, container);
    // Both are opaque strings the same client holds, so nothing but the
    // domain separator in the hash keeps one from being spent as the other.
    // An invite that authenticated as a device would be a device that could
    // enrol more devices.
    expect(
      (await request(app).get('/device').set(auth(device.inviteToken))).status,
    ).toBe(401);
  });

  it('refuses a device token presented as an invite code', async () => {
    const device = await enrolDevice(app, container);

    const res = await request(app)
      .post('/enroll')
      .send({ inviteToken: device.deviceToken, publicKey: clientKeypair().publicKey });

    expect(res.status).toBe(401);
  });
});

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
  enrolDevice,
  type TestNode,
} from './helpers.js';

let app: Express;
let container: Container;
let fra: TestNode;

beforeEach(async () => {
  ({ app, container } = await createHarness());
  fra = await addNode(container);
});

describe('enrolling a device', () => {
  it('never returns a private key when the device supplied its own', async () => {
    const { token } = await container.invites.mint({ deviceLimit: 5 });
    const keys = clientKeypair();

    const created = await request(app)
      .post('/enroll')
      .send({ inviteToken: token, publicKey: keys.publicKey, platform: 'android' })
      .expect(201);

    expect(created.body.device.publicKey).toBe(keys.publicKey);
    expect(created.body.privateKey).toBeNull();
    expect(created.body.privateKeyIncluded).toBe(false);
    expect(created.body.conf).toContain(`PrivateKey = ${PRIVATE_KEY_PLACEHOLDER}`);
    expect(created.headers['cache-control']).toBe('no-store');
  });

  it('still generates server-side when no key is supplied', async () => {
    // The fallback for clients that cannot do Curve25519 — curl, scripts. It
    // is the only path where a private key exists on the server at all, which
    // is why it announces itself.
    const { token } = await container.invites.mint({ deviceLimit: 5 });
    const created = await request(app).post('/enroll').send({ inviteToken: token }).expect(201);

    expect(created.body.privateKeyIncluded).toBe(true);
    expect(created.body.privateKey).toMatch(/^[A-Za-z0-9+/]{43}=$/);
  });

  it('gives the device an address on every node, not just the default', async () => {
    const ams = await addNode(container, { region: 'nl-ams', addressPoolCidr: '10.9.0.0/24' });
    const device = await enrolDevice(app, container);

    const me = await request(app)
      .get('/device')
      .set(auth(device.deviceToken))
      .expect(200);

    const regions = (me.body.device.locations as Array<{ serverId: number }>)
      .map((l) => l.serverId)
      .sort();
    expect(regions).toEqual([fra.id, ams.id].sort());
  });

  it('rejects a malformed public key rather than storing it', async () => {
    const { token } = await container.invites.mint({ deviceLimit: 5 });
    await request(app)
      .post('/enroll')
      .send({ inviteToken: token, publicKey: 'not-a-key' })
      .expect(400);
  });
});

describe('a device acting on itself', () => {
  it('returns a config complete enough for wg-quick', async () => {
    const device = await enrolDevice(app, container);

    const config = await request(app)
      .get('/device/config')
      .set(auth(device.deviceToken))
      .expect(200);

    for (const key of ['[Interface]', 'Address =', '[Peer]', 'PublicKey =', 'AllowedIPs =', 'Endpoint =']) {
      expect(config.body.conf).toContain(key);
    }
    expect(config.body.conf).not.toContain('\r');
  });

  it('can ask for a specific node', async () => {
    const ams = await addNode(container, { region: 'nl-ams', addressPoolCidr: '10.9.0.0/24' });
    const device = await enrolDevice(app, container);

    const config = await request(app)
      .get(`/device/config?serverId=${ams.id}`)
      .set(auth(device.deviceToken))
      .expect(200);

    expect(config.body.server.region).toBe('nl-ams');
  });

  it('refuses a rotation to the key it already has', async () => {
    const device = await enrolDevice(app, container);

    await request(app)
      .post('/device/rotate')
      .set(auth(device.deviceToken))
      .send({ publicKey: device.publicKey })
      .expect(409);
  });

  it('cannot reach another device, because it cannot name one', async () => {
    const first = await enrolDevice(app, container);
    const second = await enrolDevice(app, container);

    const me = await request(app)
      .get('/device')
      .set(auth(second.deviceToken))
      .expect(200);

    // There is no id in any path here, so a device token can only ever act on
    // its own device. That is the whole reason these routes need no ownership
    // check.
    expect(me.body.device.id).toBe(second.deviceId);
    expect(me.body.device.id).not.toBe(first.deviceId);
  });
});

describe('GET /servers', () => {
  it('lists the regions a device can choose', async () => {
    await addNode(container, { region: 'nl-ams', addressPoolCidr: '10.9.0.0/24' });
    const device = await enrolDevice(app, container);

    const res = await request(app)
      .get('/servers')
      .set(auth(device.deviceToken))
      .expect(200);

    expect(res.body.servers.map((s: { region: string }) => s.region).sort()).toEqual([
      'de-fra',
      'nl-ams',
    ]);
  });

  it('is not public', async () => {
    await request(app).get('/servers').expect(401);
  });
});

describe('operational endpoints', () => {
  it('answers /health without a credential', async () => {
    const res = await request(app).get('/health').expect(200);
    expect(res.body.status).toBe('ok');
  });

  it('returns a structured 404 for an unknown route', async () => {
    const res = await request(app).get('/nope').expect(404);
    expect(res.body.error.code).toBe('not_found');
  });
});

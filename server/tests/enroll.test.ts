import { describe, expect, it, beforeEach } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';

import { addNode, createHarness, type Harness } from './helpers.js';

const KEY = (seed: string) => Buffer.from(seed.repeat(32).slice(0, 32)).toString('base64');

describe('enrolment', () => {
  let app: Express;
  let harness: Harness;
  let token: string;

  beforeEach(async () => {
    harness = await createHarness();
    app = harness.app;
    // Enrolment allocates an address on every allocatable node, so there has
    // to be one; without it every case here fails as 422 for the wrong reason.
    await addNode(harness.container, { region: 'test', isDefault: true });
    ({ token } = await harness.container.invites.mint({ deviceLimit: 2 }));
  });

  it('turns an invite into a working device in one call', async () => {
    const res = await request(app)
      .post('/enroll')
      .send({ inviteToken: token, publicKey: KEY('a'), platform: 'linux' })
      .expect(201);

    expect(res.body.device.publicKey).toBe(KEY('a'));
    expect(res.body.deviceToken).toMatch(/^vpndev_/);
    expect(res.body.conf).toContain('<PRIVATE_KEY>');
    // The property the whole design rests on, unchanged by dropping accounts.
    expect(res.body.privateKey).toBeNull();
  });

  it('refuses an invite that does not exist', async () => {
    await request(app)
      .post('/enroll')
      .send({ inviteToken: 'ZZZZZZZZZZ', publicKey: KEY('b') })
      .expect(401);
  });

  it('refuses a code that has been rotated away', async () => {
    const minted = await harness.container.invites.mint({ deviceLimit: 5 });
    await harness.container.invites.rotate(minted.invite.id);

    // 401, not 403: rotating overwrites the hash, so the old code is simply
    // not a code any more. Nothing records that it once was, which is why
    // there is no answer that could tell "revoked" from "never existed".
    await request(app)
      .post('/enroll')
      .send({ inviteToken: minted.token, publicKey: KEY('c') })
      .expect(401);
  });

  it('enforces the invite own device limit, not a global one', async () => {
    await request(app).post('/enroll').send({ inviteToken: token, publicKey: KEY('d') }).expect(201);
    await request(app).post('/enroll').send({ inviteToken: token, publicKey: KEY('e') }).expect(201);

    // deviceLimit was 2 for this invite.
    await request(app).post('/enroll').send({ inviteToken: token, publicKey: KEY('f') }).expect(409);
  });

  it('gives the device a token that works on its own routes', async () => {
    const enrolled = await request(app)
      .post('/enroll')
      .send({ inviteToken: token, publicKey: KEY('g') })
      .expect(201);
    const deviceToken = enrolled.body.deviceToken as string;

    const me = await request(app)
      .get('/device')
      .set('authorization', `Bearer ${deviceToken}`)
      .expect(200);
    expect(me.body.device.id).toBe(enrolled.body.device.id);

    const config = await request(app)
      .get('/device/config')
      .set('authorization', `Bearer ${deviceToken}`)
      .expect(200);
    expect(config.body.conf).toContain('[Interface]');
  });

  it('will not accept the invite token where a device token belongs', async () => {
    // Domain separation, checked through the HTTP surface rather than only in
    // the service: an invite must not be usable as a device credential.
    await request(app).get('/device').set('authorization', `Bearer ${token}`).expect(401);
  });

  it('rotates a key without touching the device identity', async () => {
    const enrolled = await request(app)
      .post('/enroll')
      .send({ inviteToken: token, publicKey: KEY('h') })
      .expect(201);
    const deviceToken = enrolled.body.deviceToken as string;

    const rotated = await request(app)
      .post('/device/rotate')
      .set('authorization', `Bearer ${deviceToken}`)
      .send({ publicKey: KEY('i') })
      .expect(200);

    expect(rotated.body.device.id).toBe(enrolled.body.device.id);
    expect(rotated.body.device.publicKey).toBe(KEY('i'));
    expect(rotated.body.device.locations[0].allowedIp).toBe(
      enrolled.body.device.locations[0].allowedIp,
    );
  });

  it('lets a device remove itself, and stops answering it afterwards', async () => {
    const enrolled = await request(app)
      .post('/enroll')
      .send({ inviteToken: token, publicKey: KEY('j') })
      .expect(201);
    const deviceToken = enrolled.body.deviceToken as string;

    await request(app)
      .delete('/device')
      .set('authorization', `Bearer ${deviceToken}`)
      .expect(204);

    await request(app).get('/device').set('authorization', `Bearer ${deviceToken}`).expect(401);
  });

  it('frees the address when a device removes itself', async () => {
    const first = await request(app)
      .post('/enroll')
      .send({ inviteToken: token, publicKey: KEY('k') })
      .expect(201);
    const address = first.body.device.locations[0].allowedIp;

    await request(app)
      .delete('/device')
      .set('authorization', `Bearer ${first.body.deviceToken}`)
      .expect(204);

    const second = await request(app)
      .post('/enroll')
      .send({ inviteToken: token, publicKey: KEY('l') })
      .expect(201);
    expect(second.body.device.locations[0].allowedIp).toBe(address);
  });
});

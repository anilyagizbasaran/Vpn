import { generateKeyPairSync } from 'node:crypto';
import type { Express } from 'express';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { createContainer, type Container } from '../src/container.js';
import { hashNodeToken } from '../src/services/nodeService.js';
import type { CreateServerInput } from '../src/db/repositories.js';

/**
 * Read rather than copied. It used to be a literal that happened to match
 * tests/setup.ts, so renaming the variable there made every node token hash
 * differently and ten tests started answering 401 with nothing saying why.
 */
export const NODE_TOKEN_PEPPER = process.env['TOKEN_PEPPER']!;

export const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

/** A keypair generated the way the apps do: only the public half is sent. */
export function clientKeypair(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  return {
    publicKey: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64'),
    privateKey: privateKey
      .export({ type: 'pkcs8', format: 'der' })
      .subarray(-32)
      .toString('base64'),
  };
}

export function serverInput(overrides: Partial<CreateServerInput> = {}): CreateServerInput {
  return {
    region: 'de-fra',
    displayName: 'Frankfurt',
    publicKey: clientKeypair().publicKey,
    endpoint: 'fra.vpn.test:51820',
    listenPort: 51820,
    interfaceName: 'wg0',
    addressPoolCidr: '10.8.0.0/24',
    serverAddress: '10.8.0.1',
    dns: '1.1.1.1',
    isDefault: true,
    status: 'active',
    agentTokenHash: null,
    ...overrides,
  };
}

export interface TestNode {
  id: number;
  region: string;
  token: string;
  publicKey: string;
}

/**
 * Defines a node and provisions its agent token, the way `npm run node:add`
 * does. Also marks it as having just synced, because a node that has never
 * reported is treated as offline and hidden from the region list.
 */
export async function addNode(
  container: Container,
  overrides: Partial<CreateServerInput> = {},
  options: { markOnline?: boolean } = {},
): Promise<TestNode> {
  const input = serverInput(overrides);
  const server = await container.repos.servers.upsertByRegion(input);

  const token = `node-token-${server.region}`;
  await container.repos.servers.setAgentTokenHash(
    server.id,
    hashNodeToken(NODE_TOKEN_PEPPER, token),
  );

  if (options.markOnline ?? true) {
    await container.repos.servers.recordHeartbeat({
      id: server.id,
      agentVersion: 'test',
      reportedPublicKey: input.publicKey,
      seenAt: new Date().toISOString(),
    });
  }

  return { id: server.id, region: server.region, token, publicKey: input.publicKey };
}

export interface Harness {
  app: Express;
  container: Container;
}

export async function createHarness(): Promise<Harness> {
  const container = await createContainer({
    databasePath: ':memory:',
    skipBootstrapNode: true,
  });
  return { app: createApp(container), container };
}

/** Everything an agent would see on its next sync. */
export async function nodeSync(
  app: Express,
  node: TestNode,
  usage: {
    publicKey: string;
    rxBytes: number;
    txBytes: number;
    lastHandshakeAt?: string | null;
  }[] = [],
) {
  return request(app)
    .post('/node/sync')
    .set(auth(node.token))
    .send({
      interfacePublicKey: node.publicKey,
      agentVersion: 'test-agent/1.0',
      usage: usage.map((entry) => ({ lastHandshakeAt: null, ...entry })),
    });
}

export interface EnrolledDevice {
  deviceToken: string;
  deviceId: number;
  publicKey: string;
  privateKey: string;
  inviteToken: string;
}

/**
 * The setup every device test needs now: an invite, and a device enrolled with
 * it. There is no account to make: an invite is the whole of it.
 */
export async function enrolDevice(
  app: Express,
  container: Container,
  options: { deviceLimit?: number; inviteToken?: string } = {},
): Promise<EnrolledDevice> {
  let inviteToken = options.inviteToken;
  if (!inviteToken) {
    ({ token: inviteToken } = await container.invites.mint({ deviceLimit: options.deviceLimit ?? 5,
    }));
  }

  const keys = clientKeypair();
  const response = await request(app)
    .post('/enroll')
    .send({ inviteToken, publicKey: keys.publicKey, platform: 'linux' })
    .expect(201);

  return {
    deviceToken: response.body.deviceToken as string,
    deviceId: response.body.device.id as number,
    publicKey: keys.publicKey,
    privateKey: keys.privateKey,
    inviteToken,
  };
}

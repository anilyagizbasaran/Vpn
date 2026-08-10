import { generateKeyPairSync } from 'node:crypto';
import type { Express } from 'express';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { createContainer, type Container } from '../src/container.js';
import { hashNodeToken } from '../src/services/nodeService.js';
import type { CreateServerInput } from '../src/db/repositories.js';

export const PASSWORD = 'a-long-enough-password';
export const NODE_TOKEN_PEPPER = 'test-refresh-pepper-not-used-in-production';

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

export interface TestAccount {
  accessToken: string;
  refreshToken: string;
  userId: number;
  email: string;
}

export async function registerUser(app: Express, email: string): Promise<TestAccount> {
  const res = await request(app).post('/auth/register').send({ email, password: PASSWORD });
  if (res.status !== 201) {
    throw new Error(`register failed for ${email}: ${res.status} ${res.text}`);
  }
  return {
    accessToken: res.body.tokens.accessToken,
    refreshToken: res.body.tokens.refreshToken,
    userId: res.body.user.id,
    email,
  };
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

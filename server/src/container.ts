import { env, tokenPepper } from './config/env.js';
import type { Repositories } from './db/repositories.js';
import { openDatabase, type Db } from './db/sqlite.js';
import { createSqliteRepositories } from './db/sqliteRepositories.js';
import { InviteService } from './services/inviteService.js';
import { DeviceService } from './services/deviceService.js';
import { NodeService } from './services/nodeService.js';
import { logger } from './utils/logger.js';

export interface Container {
  db: Db;
  repos: Repositories;
  invites: InviteService;
  devices: DeviceService;
  nodes: NodeService;
  close(): void;
}

export interface ContainerOptions {
  databasePath?: string;
  /** Skip defining the bootstrap node; tests define their own. */
  skipBootstrapNode?: boolean;
}

export async function createContainer(options: ContainerOptions = {}): Promise<Container> {
  const db = openDatabase(options.databasePath ?? env.DATABASE_PATH);
  const repos = createSqliteRepositories(db);


  const pepper = tokenPepper(env);

  const devices = new DeviceService(repos, {
    enablePresharedKey: env.WG_ENABLE_PRESHARED_KEY,
    pskEncryptionKey: env.PSK_ENCRYPTION_KEY,
    clientAllowedIps: env.WG_CLIENT_ALLOWED_IPS,
    persistentKeepalive: env.WG_PERSISTENT_KEEPALIVE,
    clientMtu: env.WG_CLIENT_MTU,
  });

  const nodes = new NodeService(repos, {
    tokenPepper: pepper,
    pskEncryptionKey: env.PSK_ENCRYPTION_KEY,
    pollSeconds: env.NODE_POLL_SECONDS,
  });

  const invites = new InviteService(repos, { tokenPepper: pepper });

  if (!(options.skipBootstrapNode ?? env.WG_SKIP_BOOTSTRAP_NODE)) {
    await defineBootstrapNode(repos);
  }

  return { db, repos, invites, devices, nodes, close: () => db.close() };
}

/**
 * Defines one node from the environment on every boot.
 *
 * A convenience for the common single-node install: edit .env, restart, done.
 * Additional nodes are added with `npm run node:add`, which is also what mints
 * their agent token — this path deliberately never touches an existing token,
 * so a restart cannot lock an agent out.
 */
async function defineBootstrapNode(repos: Repositories): Promise<void> {
  const publicKey = env.WG_SERVER_PUBLIC_KEY.trim();
  if (publicKey === '') {
    logger.error('no bootstrap node public key; skipping node definition');
    return;
  }

  const server = await repos.servers.upsertByRegion({
    region: env.WG_REGION,
    displayName: env.WG_DISPLAY_NAME || env.WG_REGION,
    publicKey,
    endpoint: env.WG_ENDPOINT,
    listenPort: env.WG_LISTEN_PORT,
    interfaceName: env.WG_INTERFACE,
    addressPoolCidr: env.WG_ADDRESS_POOL,
    serverAddress: env.WG_SERVER_ADDRESS,
    dns: env.WG_DNS,
    isDefault: true,
    status: 'active',
    agentTokenHash: null,
  });

  if (!server.agentTokenHash) {
    // Without an agent the peers exist in the database and nowhere else.
    logger.warn('the bootstrap node has no agent token; run `npm run node:add` to mint one', {
      region: server.region,
    });
  }
}

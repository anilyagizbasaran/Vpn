import { env } from './config/env.js';
import type { Repositories } from './db/repositories.js';
import { openDatabase, type Db } from './db/sqlite.js';
import { createSqliteRepositories } from './db/sqliteRepositories.js';
import { AccountService } from './services/accountService.js';
import { AuthService } from './services/authService.js';
import { PeerService } from './services/peerService.js';
import { createWireGuardController } from './services/wireguard/index.js';
import type { WireGuardController } from './services/wireguard/index.js';
import { logger } from './utils/logger.js';

export interface Container {
  db: Db;
  repos: Repositories;
  auth: AuthService;
  account: AccountService;
  peers: PeerService;
  wg: WireGuardController;
  close(): void;
}

export interface ContainerOptions {
  databasePath?: string;
  wg?: WireGuardController;
}

export async function createContainer(options: ContainerOptions = {}): Promise<Container> {
  const db = openDatabase(options.databasePath ?? env.DATABASE_PATH);
  const repos = createSqliteRepositories(db);
  const wg = options.wg ?? createWireGuardController();

  const auth = new AuthService(repos, {
    accessSecret: env.JWT_ACCESS_SECRET,
    accessTtl: env.JWT_ACCESS_TTL,
    refreshPepper: env.JWT_REFRESH_PEPPER,
    refreshTtlDays: env.REFRESH_TTL_DAYS,
    issuer: env.JWT_ISSUER,
    revokedRetentionDays: env.REFRESH_REVOKED_RETENTION_DAYS,
  });

  const peers = new PeerService(repos, wg, {
    maxPeersPerUser: env.MAX_PEERS_PER_USER,
    enablePresharedKey: env.WG_ENABLE_PRESHARED_KEY,
    pskEncryptionKey: env.PSK_ENCRYPTION_KEY,
    clientAllowedIps: env.WG_CLIENT_ALLOWED_IPS,
    persistentKeepalive: env.WG_PERSISTENT_KEEPALIVE,
    clientMtu: env.WG_CLIENT_MTU,
  });

  const account = new AccountService(repos, auth, peers);

  await registerServerFromEnv(repos, wg);

  return {
    db,
    repos,
    auth,
    account,
    peers,
    wg,
    close: () => db.close(),
  };
}

/**
 * The `servers` row is derived from .env on every boot. That keeps a single
 * source of truth for operators (edit .env, restart) while still storing the
 * values in the database, where peers can reference them by id.
 */
async function registerServerFromEnv(
  repos: Repositories,
  wg: WireGuardController,
): Promise<void> {
  const liveKey = await wg.getInterfacePublicKey();
  const publicKey = env.WG_SERVER_PUBLIC_KEY.trim() || liveKey || '';

  if (publicKey === '') {
    logger.error('no server public key available from env or the live interface');
    return;
  }

  if (liveKey && env.WG_SERVER_PUBLIC_KEY.trim() && liveKey !== env.WG_SERVER_PUBLIC_KEY.trim()) {
    // Clients would receive a config that can never handshake. Loud on purpose.
    logger.error('WG_SERVER_PUBLIC_KEY does not match the live interface key', {
      interface: wg.interfaceName,
    });
  }

  await repos.servers.upsertByRegion({
    region: env.WG_REGION,
    publicKey,
    endpoint: env.WG_ENDPOINT,
    listenPort: env.WG_LISTEN_PORT,
    interfaceName: env.WG_INTERFACE,
    addressPoolCidr: env.WG_ADDRESS_POOL,
    serverAddress: env.WG_SERVER_ADDRESS,
    dns: env.WG_DNS,
    isDefault: true,
  });
}

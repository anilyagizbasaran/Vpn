import { createApp } from './app.js';
import { env } from './config/env.js';
import { createContainer } from './container.js';
import { logger } from './utils/logger.js';

const ONE_HOUR = 60 * 60 * 1000;

async function main(): Promise<void> {
  const container = await createContainer();

  if (env.WG_SYNC_ON_BOOT) {
    // The database is the source of truth. `wg set` state is lost on reboot,
    // so every live peer is re-applied and anything unknown is removed.
    try {
      await container.peers.syncInterface();
    } catch (error) {
      logger.error('interface sync failed at boot — peers may be unreachable', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const app = createApp(container);
  const server = app.listen(env.PORT, () => {
    logger.info('control plane listening', {
      port: env.PORT,
      env: env.NODE_ENV,
      wireguard: container.wg.kind,
    });
  });

  const cleanup = setInterval(() => {
    void container.auth
      .purgeStaleTokens()
      .then((deleted) => {
        if (deleted > 0) logger.info('stale refresh tokens purged', { deleted });
      })
      .catch((error: unknown) => {
        logger.warn('refresh token purge failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }, ONE_HOUR);
  cleanup.unref();

  const shutdown = (signal: string) => {
    logger.info('shutting down', { signal });
    clearInterval(cleanup);
    server.close(() => {
      container.close();
      process.exit(0);
    });
    // Do not hang forever on a stuck connection.
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((error: unknown) => {
  logger.error('failed to start', {
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
  process.exit(1);
});

import { createApp } from './app.js';
import { env } from './config/env.js';
import { createContainer } from './container.js';
import { logger } from './utils/logger.js';

async function main(): Promise<void> {
  const container = await createContainer();

  // Nothing to reconcile at boot any more: node agents pull their peer set and
  // converge on their own. The control plane is a plain web service — no
  // privileges, no interface, nothing to restore.
  const app = createApp(container);
  const server = app.listen(env.PORT, () => {
    logger.info('control plane listening', { port: env.PORT, env: env.NODE_ENV });
  });

  // Nothing to sweep any more: refresh tokens were the only rows that expired
  // on their own, and invites and device tokens are revoked deliberately or
  // not at all.

  const shutdown = (signal: string) => {
    logger.info('shutting down', { signal });
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

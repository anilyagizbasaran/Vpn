import { randomUUID } from 'node:crypto';
import cors from 'cors';
import express from 'express';
import type { Express } from 'express';
import helmet from 'helmet';
import { env } from './config/env.js';
import type { Repositories } from './db/repositories.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { globalLimiter, healthLimiter } from './middleware/rateLimiters.js';
import { createRequireAuth } from './middleware/requireAuth.js';
import { createAuthRouter } from './routes/auth.routes.js';
import { createHealthRouter } from './routes/health.routes.js';
import { createPeersRouter } from './routes/peers.routes.js';
import type { AccountService } from './services/accountService.js';
import type { AuthService } from './services/authService.js';
import type { PeerService } from './services/peerService.js';
import type { WireGuardController } from './services/wireguard/index.js';
import { logger } from './utils/logger.js';

export interface AppDependencies {
  repos: Repositories;
  auth: AuthService;
  account: AccountService;
  peers: PeerService;
  wg: WireGuardController;
}

export function createApp({ repos, auth, account, peers, wg }: AppDependencies): Express {
  const app = express();

  // Must match the real number of proxies, otherwise a client can forge
  // X-Forwarded-For and escape per-IP rate limiting.
  app.set('trust proxy', env.TRUST_PROXY);
  app.disable('x-powered-by');

  app.use(helmet());
  app.use(
    cors(
      env.CORS_ORIGINS.length > 0
        ? { origin: env.CORS_ORIGINS, credentials: false }
        : { origin: false },
    ),
  );

  app.use((req, res, next) => {
    req.requestId = req.get('x-request-id') ?? randomUUID();
    res.setHeader('x-request-id', req.requestId);
    const startedAt = process.hrtime.bigint();
    res.on('finish', () => {
      logger.info('request', {
        requestId: req.requestId,
        method: req.method,
        path: req.path,
        status: res.statusCode,
        ms: Number((process.hrtime.bigint() - startedAt) / 1_000_000n),
      });
    });
    next();
  });

  // Probes are mounted ahead of the global limiter and get their own budget,
  // so an uptime monitor cannot spend the window that real users need.
  app.use('/', healthLimiter, createHealthRouter(repos, wg));

  // Rate limiting runs before body parsing: a request that is going to be
  // rejected with 429 should not first cost a 32kb JSON parse.
  app.use(globalLimiter);
  app.use(express.json({ limit: '32kb' }));

  const requireAuth = createRequireAuth(auth);

  app.use('/auth', createAuthRouter(auth, account, requireAuth));
  app.use('/peers', createPeersRouter(peers, requireAuth));

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

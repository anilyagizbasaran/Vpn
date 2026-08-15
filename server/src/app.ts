import { randomUUID } from 'node:crypto';
import cors from 'cors';
import express from 'express';
import type { Express } from 'express';
import helmet from 'helmet';
import { env } from './config/env.js';
import type { Repositories } from './db/repositories.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { globalLimiter, healthLimiter } from './middleware/rateLimiters.js';
import { createRequireDevice } from './middleware/requireDevice.js';
import { createDeviceRouter } from './routes/device.routes.js';
import { createEnrollRouter } from './routes/enroll.routes.js';
import { createServersRouter } from './routes/servers.routes.js';
import { createWhoamiRouter } from './routes/whoami.routes.js';
import { createHealthRouter } from './routes/health.routes.js';
import { createNodeRouter } from './routes/node.routes.js';
import type { DeviceService } from './services/deviceService.js';
import type { InviteService } from './services/inviteService.js';
import type { NodeService } from './services/nodeService.js';
import { logger } from './utils/logger.js';

export interface AppDependencies {
  repos: Repositories;
  invites: InviteService;
  devices: DeviceService;
  nodes: NodeService;
}

export function createApp({ repos, invites, devices, nodes }: AppDependencies): Express {
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
      // Failures only. A line per successful request carries no address and
      // no device, but it still says this server was used at 03:14 and again
      // at 03:47 — and with one person behind one invite code, an activity
      // timeline is close enough to identifying them. The database keeps no
      // history on purpose; the log must not quietly keep one instead.
      if (res.statusCode < 400) return;

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
  app.use('/', healthLimiter, createHealthRouter(repos));

  // Rate limiting runs before body parsing: a request that is going to be
  // rejected with 429 should not first cost a JSON parse.
  app.use(globalLimiter);

  // Node agents report every peer's counters, so their bodies are far larger
  // than a user's. Mounted before the tighter global parser.
  app.use('/node', express.json({ limit: '2mb' }), createNodeRouter(nodes));

  // Configs are a few hundred bytes; nothing legitimate needs more than this.
  app.use(express.json({ limit: '32kb' }));


  // Enrolment, and the routes a device uses on itself and to list regions.
  const requireDevice = createRequireDevice(invites);
  app.use('/enroll', createEnrollRouter(devices, invites));
  app.use('/device', createDeviceRouter(devices, requireDevice));
  app.use('/servers', createServersRouter(devices, requireDevice));
  app.use('/whoami', createWhoamiRouter(devices, requireDevice));


  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

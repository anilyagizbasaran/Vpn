import { Router } from 'express';
import type { Repositories } from '../db/repositories.js';
import type { WireGuardController } from '../services/wireguard/index.js';

export function createHealthRouter(repos: Repositories, wg: WireGuardController): Router {
  const router = Router();

  /** Liveness only — cheap enough for a load balancer to poll. */
  router.get('/health', (_req, res) => {
    res.json({ status: 'ok', uptime: Math.round(process.uptime()) });
  });

  /**
   * Readiness: confirms the database answers and the interface is reachable.
   * Intentionally unauthenticated but leaks nothing beyond region names.
   */
  router.get('/ready', async (_req, res) => {
    const server = await repos.servers.getDefault();
    const interfaceKey = await wg.getInterfacePublicKey();

    const ready = server !== null && interfaceKey !== null;
    res.status(ready ? 200 : 503).json({
      status: ready ? 'ready' : 'degraded',
      wireguard: {
        backend: wg.kind,
        interface: wg.interfaceName,
        reachable: interfaceKey !== null,
        // A mismatch means .env and the live interface disagree, which would
        // hand clients a config that can never complete a handshake.
        keyMatchesConfig: server ? interfaceKey === server.publicKey : null,
      },
      server: server ? { region: server.region, endpoint: server.endpoint } : null,
    });
  });

  return router;
}

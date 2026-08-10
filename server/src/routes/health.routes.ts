import { Router } from 'express';
import type { Repositories } from '../db/repositories.js';

/** A node that has not synced in this long is reported as stale. */
const STALE_AFTER_MS = 3 * 60 * 1000;

export function createHealthRouter(repos: Repositories): Router {
  const router = Router();

  /** Liveness only — cheap enough for a load balancer to poll. */
  router.get('/health', (_req, res) => {
    res.json({ status: 'ok', uptime: Math.round(process.uptime()) });
  });

  /**
   * Readiness. The control plane no longer touches a WireGuard interface, so
   * what matters here is whether the database answers and whether the nodes
   * are still reporting — a fleet where every agent has gone quiet accepts
   * signups and hands out configs that nothing will ever apply.
   */
  router.get('/ready', async (_req, res) => {
    const servers = await repos.servers.list();
    const now = Date.now();

    const nodes = servers.map((server) => {
      const lastSeen = server.lastSeenAt ? Date.parse(server.lastSeenAt) : null;
      return {
        region: server.region,
        endpoint: server.endpoint,
        status: server.status,
        agentProvisioned: server.agentTokenHash !== null,
        lastSeenAt: server.lastSeenAt,
        online: lastSeen !== null && now - lastSeen < STALE_AFTER_MS,
        // A node rebuilt with a new key would otherwise hand every client in
        // that region a config that can never handshake.
        keyMatchesConfig:
          server.reportedPublicKey === null
            ? null
            : server.reportedPublicKey === server.publicKey,
      };
    });

    const ready = nodes.some((node) => node.online && node.status === 'active');

    res.status(ready ? 200 : 503).json({
      status: ready ? 'ready' : 'degraded',
      nodes,
    });
  });

  return router;
}

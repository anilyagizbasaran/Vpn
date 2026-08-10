import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import type { NodeService } from '../services/nodeService.js';
import type { VpnServer } from '../db/types.js';
import { parseBody } from '../middleware/validate.js';
import { unauthorized } from '../utils/errors.js';
import { isTest } from '../config/env.js';
import { logger } from '../utils/logger.js';

const wireGuardKey = z
  .string()
  .regex(/^[A-Za-z0-9+/]{43}=$/, 'not a base64-encoded 32-byte WireGuard key');

const syncSchema = z.object({
  interfacePublicKey: wireGuardKey,
  agentVersion: z.string().min(1).max(64),
  usage: z
    .array(
      z.object({
        publicKey: wireGuardKey,
        // WireGuard counters are 64-bit; JSON numbers hold them exactly up to
        // 2^53 bytes, which is eight petabytes per peer.
        rxBytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
        txBytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
        lastHandshakeAt: z.iso.datetime().nullable().default(null),
      }),
    )
    // A node with more peers than this is reporting garbage or is under
    // attack; either way the control plane should not try to fold it in.
    .max(10_000)
    .default([]),
});

declare module 'express-serve-static-core' {
  interface Request {
    /** Set by the node agent guard. */
    node?: VpnServer;
  }
}

/**
 * Agents sync every ten seconds or so; the limit is generous enough for a
 * fleet behind one NAT and tight enough that a leaked token cannot be used to
 * hammer the database.
 */
const nodeLimiter = rateLimit({
  windowMs: 60_000,
  limit: 120,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  skip: () => isTest,
  handler: (_req, res) => {
    res.status(429).json({
      error: { code: 'rate_limited', message: 'Too many sync requests.' },
    });
  },
});

export function createNodeRouter(nodes: NodeService): Router {
  const router = Router();

  const requireNode = (req: Request, _res: Response, next: NextFunction) => {
    const header = req.get('authorization');
    if (!header || !header.toLowerCase().startsWith('bearer ')) {
      next(unauthorized('Missing node token'));
      return;
    }

    nodes
      .authenticate(header.slice(7).trim())
      .then((server) => {
        req.node = server;
        next();
      })
      .catch((error: unknown) => {
        logger.warn('node authentication failed', { ip: req.ip });
        next(error);
      });
  };

  /**
   * The whole node protocol: one call that reports what the node sees and
   * returns what it should have. Combining them keeps the agent a loop with
   * no state of its own — whatever the response says is the truth, so a node
   * that was offline for an hour converges on its first successful sync.
   */
  router.post('/sync', nodeLimiter, requireNode, async (req, res) => {
    const server = req.node;
    if (!server) throw unauthorized();

    const body = parseBody(syncSchema, req.body ?? {});
    res.set('Cache-Control', 'no-store').json(await nodes.sync(server, body));
  });

  return router;
}

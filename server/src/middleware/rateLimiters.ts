import type { Request, Response } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { isTest } from '../config/env.js';
import { logger } from '../utils/logger.js';

function limitReached(req: Request, res: Response): void {
  logger.warn('rate limit hit', { path: req.path, ip: req.ip, requestId: req.requestId });
  res.status(429).json({
    error: { code: 'rate_limited', message: 'Too many requests. Slow down and try again later.' },
  });
}

const common = {
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  handler: limitReached,
  // Tests hammer the same endpoints on purpose; limits are exercised by a
  // dedicated test that builds its own limiter instead.
  skip: () => isTest,
} as const;

/** Blanket limit so a single IP cannot saturate the process. */
export const globalLimiter = rateLimit({ ...common, windowMs: 15 * 60_000, limit: 300 });

/**
 * Probes get their own budget. Under the global limit a monitor polling every
 * five seconds would burn 180 of 300 requests per window and start 429-ing
 * real users. Still capped, because /ready touches the database and the
 * WireGuard interface and is unauthenticated.
 */
export const healthLimiter = rateLimit({ ...common, windowMs: 60_000, limit: 120 });

/** Credential endpoints: slow enough to make online guessing pointless. */
export const authLimiter = rateLimit({ ...common, windowMs: 15 * 60_000, limit: 10 });

/** Refresh is called often by a legitimate app, so it gets its own budget. */
export const refreshLimiter = rateLimit({ ...common, windowMs: 15 * 60_000, limit: 60 });

/**
 * Peer creation burns an address from the pool and shells out to `wg`, so it
 * is limited per authenticated user rather than per IP — several users behind
 * one carrier NAT must not starve each other.
 */
export const peerWriteLimiter = rateLimit({
  ...common,
  windowMs: 60 * 60_000,
  limit: 30,
  keyGenerator: (req: Request) =>
    req.auth ? `user:${req.auth.userId}` : ipKeyGenerator(req.ip ?? 'unknown'),
});

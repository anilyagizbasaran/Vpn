import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { InviteService } from '../services/inviteService.js';
import { unauthorized } from '../utils/errors.js';

/**
 * Authenticates a device by the token it was issued at enrolment.
 *
 * Simpler than the account path it replaces, and stricter by construction. An
 * access token is a signed claim that stays valid until it expires, so that
 * path had to re-read the account on every request to notice a revocation.
 * A device token is not a claim about anything — it is a lookup — so a revoked
 * device stops working on its next request with no extra check to remember.
 */
export function createRequireDevice(invites: InviteService): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    const header = req.get('authorization');
    if (!header || !header.toLowerCase().startsWith('bearer ')) {
      next(unauthorized('Missing Bearer token'));
      return;
    }

    invites
      .resolveDevice(header.slice(7).trim())
      .then((device) => {
        req.device = device;
        next();
      })
      .catch(next);
  };
}

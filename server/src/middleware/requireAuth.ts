import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { AuthService } from '../services/authService.js';
import { unauthorized } from '../utils/errors.js';

/**
 * Verifies the bearer token *and* re-checks the account behind it on every
 * request.
 *
 * The signature check alone is not enough: an access token stays
 * cryptographically valid for its full 15 minutes, so without this lookup a
 * deleted or disabled account would keep working until the token expired —
 * including for a `POST /devices` whose user_id no longer exists.
 *
 * The cost is one primary-key read per authenticated request against an
 * in-process SQLite database. That is the right trade at this scale; if the
 * database ever moves out of process, cache it with a short TTL rather than
 * dropping the check.
 */
export function createRequireAuth(auth: AuthService): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    const header = req.get('authorization');
    if (!header || !header.toLowerCase().startsWith('bearer ')) {
      next(unauthorized('Missing Bearer token'));
      return;
    }

    let claims: { userId: number };
    try {
      claims = auth.verifyAccessToken(header.slice(7).trim());
    } catch (error) {
      next(error);
      return;
    }

    // `getUser` throws 401 when the account is gone and 403 when it is disabled.
    auth
      .getUser(claims.userId)
      .then(() => {
        req.auth = claims;
        next();
      })
      .catch(next);
  };
}

/** Narrows `req.auth` for handlers mounted behind `requireAuth`. */
export function authContext(req: Request): { userId: number } {
  if (!req.auth) throw unauthorized();
  return req.auth;
}

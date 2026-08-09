import { Router } from 'express';
import { z } from 'zod';
import type { AccountService } from '../services/accountService.js';
import type { AuthService } from '../services/authService.js';
import { authContext } from '../middleware/requireAuth.js';
import { authLimiter, refreshLimiter } from '../middleware/rateLimiters.js';
import { parseBody } from '../middleware/validate.js';
import { isEmail } from '../utils/validation.js';
import type { RequestHandler } from 'express';

const credentialsSchema = z.object({
  email: z
    .string()
    .trim()
    .max(254)
    .refine(isEmail, { message: 'Must be a valid email address' }),
  // 10 chars minimum with no composition rules: length beats character
  // classes, and the hash is scrypt so long passwords cost nothing extra.
  password: z
    .string()
    .min(10, 'Password must be at least 10 characters')
    .max(256, 'Password must be at most 256 characters'),
});

const refreshSchema = z.object({
  refreshToken: z.string().min(20, 'Missing refresh token'),
});

const deleteAccountSchema = z.object({
  password: z.string().min(1, 'Confirm your password to delete the account'),
});

export function createAuthRouter(
  auth: AuthService,
  account: AccountService,
  requireAuth: RequestHandler,
): Router {
  const router = Router();

  router.post('/register', authLimiter, async (req, res) => {
    const { email, password } = parseBody(credentialsSchema, req.body);
    const result = await auth.register(email, password);
    res.status(201).json(result);
  });

  router.post('/login', authLimiter, async (req, res) => {
    const { email, password } = parseBody(credentialsSchema, req.body);
    res.json(await auth.login(email, password));
  });

  router.post('/refresh', refreshLimiter, async (req, res) => {
    const { refreshToken } = parseBody(refreshSchema, req.body);
    res.json(await auth.refresh(refreshToken));
  });

  router.post('/logout', refreshLimiter, async (req, res) => {
    const { refreshToken } = parseBody(refreshSchema, req.body);
    await auth.logout(refreshToken);
    res.status(204).end();
  });

  router.get('/me', requireAuth, async (req, res) => {
    const { userId } = authContext(req);
    res.json({ user: await auth.getUser(userId) });
  });

  // Erasure request. Rate limited like a credential endpoint because it takes
  // a password and is therefore another place to guess one.
  router.delete('/account', requireAuth, authLimiter, async (req, res) => {
    const { userId } = authContext(req);
    const { password } = parseBody(deleteAccountSchema, req.body ?? {});
    await account.deleteAccount(userId, password);
    res.status(204).end();
  });

  return router;
}

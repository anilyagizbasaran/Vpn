import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import type { Repositories } from '../db/repositories.js';
import type { User } from '../db/types.js';
import { UniqueConstraintError } from '../db/types.js';
import { hmac, randomToken } from '../utils/crypto.js';
import { hashPassword, verifyPassword } from '../utils/password.js';
import { AppError, conflict, forbidden, unauthorized } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { normalizeEmail } from '../utils/validation.js';

export interface AuthServiceConfig {
  accessSecret: string;
  accessTtl: string;
  refreshPepper: string;
  refreshTtlDays: number;
  issuer: string;
  revokedRetentionDays: number;
}

export interface AuthTokens {
  tokenType: 'Bearer';
  accessToken: string;
  /** Seconds until `accessToken` expires. */
  expiresIn: number;
  refreshToken: string;
  refreshExpiresAt: string;
}

export interface UserView {
  id: number;
  email: string;
  createdAt: string;
}

export interface AuthResult {
  user: UserView;
  tokens: AuthTokens;
}

export interface AccessTokenClaims {
  userId: number;
}

const toUserView = (user: User): UserView => ({
  id: user.id,
  email: user.email,
  createdAt: user.createdAt,
});

/**
 * A real scrypt hash of a value nobody can log in with. Verifying against it
 * when the email is unknown keeps login latency the same for existing and
 * non-existing accounts, so the endpoint cannot be used to enumerate users.
 */
let decoyHash: string | null = null;
async function decoy(): Promise<string> {
  decoyHash ??= await hashPassword(randomToken(32));
  return decoyHash;
}

export class AuthService {
  constructor(
    private readonly repos: Repositories,
    private readonly config: AuthServiceConfig,
  ) {}

  private signAccessToken(user: User): { token: string; expiresIn: number } {
    const token = jwt.sign({ typ: 'access' }, this.config.accessSecret, {
      subject: String(user.id),
      issuer: this.config.issuer,
      algorithm: 'HS256',
      // `accessTtl` is a vercel/ms duration string such as "15m"; the typings
      // model it as a template literal union, so validate-by-cast here.
      expiresIn: this.config.accessTtl as NonNullable<jwt.SignOptions['expiresIn']>,
    });

    const decoded = jwt.decode(token) as { exp?: number } | null;
    const expiresIn = decoded?.exp ? decoded.exp - Math.floor(Date.now() / 1000) : 900;
    return { token, expiresIn };
  }

  private async issueTokens(user: User, familyId: string): Promise<AuthTokens> {
    const { token: accessToken, expiresIn } = this.signAccessToken(user);

    const refreshToken = randomToken(48);
    const expiresAt = new Date(
      Date.now() + this.config.refreshTtlDays * 24 * 60 * 60 * 1000,
    ).toISOString();

    await this.repos.refreshTokens.create({
      userId: user.id,
      tokenHash: hmac(this.config.refreshPepper, refreshToken),
      familyId,
      expiresAt,
    });

    return {
      tokenType: 'Bearer',
      accessToken,
      expiresIn,
      refreshToken,
      refreshExpiresAt: expiresAt,
    };
  }

  async register(rawEmail: string, password: string): Promise<AuthResult> {
    const email = normalizeEmail(rawEmail);
    const passwordHash = await hashPassword(password);

    let user: User;
    try {
      user = await this.repos.users.create({ email, passwordHash });
    } catch (error) {
      if (error instanceof UniqueConstraintError) {
        throw conflict('An account with this email already exists');
      }
      throw error;
    }

    logger.info('user registered', { userId: user.id });
    return { user: toUserView(user), tokens: await this.issueTokens(user, randomUUID()) };
  }

  async login(rawEmail: string, password: string): Promise<AuthResult> {
    const email = normalizeEmail(rawEmail);
    const user = await this.repos.users.findByEmail(email);

    const ok = await verifyPassword(password, user?.passwordHash ?? (await decoy()));
    if (!user || !ok) throw unauthorized('Email or password is incorrect');
    if (user.disabledAt) throw forbidden('This account has been disabled');

    return { user: toUserView(user), tokens: await this.issueTokens(user, randomUUID()) };
  }

  /**
   * Rotating refresh: the presented token is revoked and replaced. Presenting
   * an already-revoked token means it leaked and was replayed, so the whole
   * family from that login is killed and the client must log in again.
   */
  async refresh(presentedToken: string): Promise<AuthResult> {
    const tokenHash = hmac(this.config.refreshPepper, presentedToken);
    const record = await this.repos.refreshTokens.findByHash(tokenHash);
    if (!record) throw unauthorized('Invalid refresh token');

    const now = new Date();
    if (record.revokedAt) {
      await this.repos.refreshTokens.revokeFamily(record.familyId, now.toISOString());
      logger.warn('refresh token reuse detected, family revoked', {
        userId: record.userId,
        familyId: record.familyId,
      });
      throw unauthorized('Refresh token has already been used. Please sign in again.');
    }
    if (new Date(record.expiresAt) <= now) throw unauthorized('Refresh token has expired');

    const user = await this.repos.users.findById(record.userId);
    if (!user) throw unauthorized('Invalid refresh token');
    if (user.disabledAt) throw forbidden('This account has been disabled');

    await this.repos.refreshTokens.revoke(record.id, now.toISOString());
    return { user: toUserView(user), tokens: await this.issueTokens(user, record.familyId) };
  }

  /** Idempotent: an unknown or already-revoked token is still a success. */
  async logout(presentedToken: string): Promise<void> {
    const record = await this.repos.refreshTokens.findByHash(
      hmac(this.config.refreshPepper, presentedToken),
    );
    if (!record) return;
    await this.repos.refreshTokens.revokeFamily(record.familyId, new Date().toISOString());
  }

  verifyAccessToken(token: string): AccessTokenClaims {
    let payload: jwt.JwtPayload;
    try {
      payload = jwt.verify(token, this.config.accessSecret, {
        issuer: this.config.issuer,
        algorithms: ['HS256'],
      }) as jwt.JwtPayload;
    } catch {
      throw unauthorized('Access token is invalid or expired');
    }

    if (payload['typ'] !== 'access') throw unauthorized('Wrong token type');

    const userId = Number(payload.sub);
    if (!Number.isInteger(userId) || userId <= 0) throw unauthorized('Malformed access token');
    return { userId };
  }

  async getUser(userId: number): Promise<UserView> {
    const user = await this.repos.users.findById(userId);
    if (!user) throw unauthorized('Account no longer exists');
    if (user.disabledAt) throw forbidden('This account has been disabled');
    return toUserView(user);
  }

  /**
   * Confirms the caller knows the account password. Required before anything
   * irreversible, because a stolen access token alone must not be enough to
   * delete somebody's account.
   *
   * A failed confirmation is 403, not 401. The caller *is* authenticated —
   * only the step-up check failed. Returning 401 would be indistinguishable
   * from an expired access token, so the client would run its refresh-and-
   * retry path, fail, and sign the user out over a typo.
   */
  async assertPassword(userId: number, password: string): Promise<User> {
    const user = await this.repos.users.findById(userId);
    if (!user) throw unauthorized('Account no longer exists');
    if (!(await verifyPassword(password, user.passwordHash))) {
      throw new AppError(403, 'invalid_password', 'Password is incorrect');
    }
    return user;
  }

  async purgeStaleTokens(): Promise<number> {
    const now = Date.now();
    return this.repos.refreshTokens.deleteStale({
      expiredBefore: new Date(now).toISOString(),
      revokedBefore: new Date(
        now - this.config.revokedRetentionDays * 24 * 60 * 60 * 1000,
      ).toISOString(),
    });
  }
}

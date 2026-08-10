import type { Repositories } from '../db/repositories.js';
import { logger } from '../utils/logger.js';
import type { AuthService } from './authService.js';
import type { DeviceService } from './deviceService.js';

/**
 * Account-level operations that span auth *and* devices. Kept out of both
 * services so neither has to depend on the other.
 */
export class AccountService {
  constructor(
    private readonly repos: Repositories,
    private readonly auth: AuthService,
    private readonly devices: DeviceService,
  ) {}

  /**
   * Erases an account: every device is revoked, then the user row is deleted
   * and ON DELETE CASCADE takes the devices, their peers and the refresh
   * tokens with it. Nothing is soft-deleted — this is the endpoint that
   * answers a GDPR erasure request, so leaving tombstones would defeat it.
   *
   * The password is re-checked first: a stolen access token must not be enough
   * to destroy an account.
   *
   * Revoking before deleting is not redundant. The cascade removes the rows,
   * but node agents learn about a peer's disappearance by *not seeing it* in
   * their next sync, and revoking first means the addresses are released even
   * if the delete were to fail halfway.
   */
  async deleteAccount(userId: number, password: string): Promise<void> {
    await this.auth.assertPassword(userId, password);

    const revoked = await this.devices.revokeAllForUser(userId);
    await this.repos.refreshTokens.revokeAllForUser(userId, new Date().toISOString());
    const deleted = await this.repos.users.delete(userId);

    logger.info('account deleted', { userId, devicesRevoked: revoked, existed: deleted });
  }
}

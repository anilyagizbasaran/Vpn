import type { Repositories } from '../db/repositories.js';
import { logger } from '../utils/logger.js';
import { wireguardFailure } from '../utils/errors.js';
import type { AuthService } from './authService.js';
import type { PeerService } from './peerService.js';

/**
 * Account-level operations that span auth *and* peers. Kept out of both
 * services so neither has to depend on the other.
 */
export class AccountService {
  constructor(
    private readonly repos: Repositories,
    private readonly auth: AuthService,
    private readonly peers: PeerService,
  ) {}

  /**
   * Erases an account: every peer comes off the WireGuard interface, then the
   * user row is deleted and ON DELETE CASCADE takes the peers and refresh
   * tokens with it. Nothing is soft-deleted — this is the endpoint that
   * answers a GDPR erasure request, so leaving tombstones would defeat it.
   *
   * The password is re-checked first: a stolen access token must not be enough
   * to destroy an account.
   *
   * Ordering matters. Interface first, database second: if the delete ran
   * first, the keys would still be live on the interface with no database row
   * left to describe them, and the boot-time sync — which only ever removes
   * peers it can enumerate — would never reach them.
   */
  async deleteAccount(userId: number, password: string): Promise<void> {
    await this.auth.assertPassword(userId, password);

    const failed = await this.peers.removeAllPeersFromInterface(userId);
    if (failed.length > 0) {
      // Refuse rather than orphan live tunnel credentials. The request is
      // safe to retry: removing an absent peer is a no-op.
      throw wireguardFailure(
        'Some devices could not be disconnected from the VPN server. ' +
          'Nothing was deleted — please retry.',
      );
    }

    await this.repos.refreshTokens.revokeAllForUser(userId, new Date().toISOString());
    const deleted = await this.repos.users.delete(userId);

    logger.info('account deleted', { userId, existed: deleted });
  }
}

import type { Repositories } from '../db/repositories.js';
import type { Device, Invite } from '../db/types.js';
import { hmac, randomToken } from '../utils/crypto.js';
import { forbidden, unauthorized } from '../utils/errors.js';

/**
 * Domain separators, so a token from one place can never be presented as a
 * token from another. Without them an invite hash and a device hash are the
 * same HMAC of the same string, and a device token would open enrolment.
 */
const INVITE_TOKEN_DOMAIN = 'invite:';
const DEVICE_TOKEN_DOMAIN = 'device:';

export function hashInviteToken(pepper: string, token: string): string {
  return hmac(pepper, INVITE_TOKEN_DOMAIN + token);
}

export function hashDeviceToken(pepper: string, token: string): string {
  return hmac(pepper, DEVICE_TOKEN_DOMAIN + token);
}

/** Recognisable at a glance in a terminal, and greppable in a log. */
const INVITE_PREFIX = 'vpninv_';
const DEVICE_PREFIX = 'vpndev_';

export interface MintedInvite {
  invite: Invite;
  /** Shown once. Only its HMAC is stored, so it cannot be shown again. */
  token: string;
}

/**
 * Invites: permission to enrol a device, and nothing else.
 *
 * This is what replaces accounts. An operator mints one, hands it over, and
 * revokes it to cut someone off — no registration, no password, no session to
 * expire. What it deliberately is *not* is a key: enrolment still requires the
 * client to generate its own pair and send only the public half, so the server
 * never holds anything that could decrypt traffic.
 */
export class InviteService {
  constructor(
    private readonly repos: Repositories,
    private readonly config: { tokenPepper: string },
  ) {}

  async mint(input: { label: string; deviceLimit: number }): Promise<MintedInvite> {
    const token = `${INVITE_PREFIX}${randomToken(32)}`;
    const invite = await this.repos.invites.create({
      label: input.label,
      tokenHash: hashInviteToken(this.config.tokenPepper, token),
      deviceLimit: input.deviceLimit,
    });
    return { invite, token };
  }

  list(): Promise<Invite[]> {
    return this.repos.invites.list();
  }

  revoke(id: number, at = new Date()): Promise<boolean> {
    return this.repos.invites.revoke(id, at.toISOString());
  }

  /**
   * Resolves an invite token to the invite it belongs to.
   *
   * A revoked invite is rejected here rather than by omitting it from the
   * lookup, so the message can say which of the two it is. Both answers are
   * safe to give: presenting the token already proves you were given it.
   */
  async resolve(token: string): Promise<Invite> {
    const invite = await this.repos.invites.findByTokenHash(
      hashInviteToken(this.config.tokenPepper, token),
    );
    if (!invite) throw unauthorized('That invite code is not valid.');
    if (invite.revokedAt) throw forbidden('That invite code has been revoked.');
    return invite;
  }

  /** Records that an invite was used, for the operator's benefit only. */
  touch(id: number, at = new Date()): Promise<void> {
    return this.repos.invites.touch(id, at.toISOString());
  }

  /**
   * A device's own credential, issued at enrolment.
   *
   * Separate from the invite on purpose: a device needs to fetch its config,
   * rotate its key and revoke itself, and if it did that with the invite then
   * one stolen phone would be able to enrol more devices.
   */
  mintDeviceToken(): { token: string; tokenHash: string } {
    const token = `${DEVICE_PREFIX}${randomToken(32)}`;
    return { token, tokenHash: hashDeviceToken(this.config.tokenPepper, token) };
  }

  async resolveDevice(token: string): Promise<Device> {
    const device = await this.repos.devices.findByTokenHash(
      hashDeviceToken(this.config.tokenPepper, token),
    );
    if (!device) throw unauthorized('This device is no longer registered.');
    return device;
  }
}

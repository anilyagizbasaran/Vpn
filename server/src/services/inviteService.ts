import type { Repositories } from '../db/repositories.js';
import type { Device, Invite } from '../db/types.js';
import { hmac, humanCode, normalizeCode, randomToken } from '../utils/crypto.js';
import { unauthorized } from '../utils/errors.js';

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

/**
 * Device tokens keep a prefix: nobody types one, they are pasted by machines,
 * and being greppable in a log is worth the length.
 *
 * Invite codes do not. They are read off a terminal and typed into a phone, so
 * every character is one a person has to get right. What the prefix bought —
 * telling the two kinds apart — is already guaranteed by the domain separators
 * above, and guaranteed properly: the hash, not the shape, is what stops one
 * being spent as the other.
 */
const DEVICE_PREFIX = 'vpndev_';

/** Characters in a code. Ten of them, from a 32-symbol alphabet: 50 bits. */
export const INVITE_CODE_LENGTH = 10;

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

  async mint(input: { deviceLimit?: number | null } = {}): Promise<MintedInvite> {
    const token = humanCode(INVITE_CODE_LENGTH);
    const invite = await this.repos.invites.create({
      tokenHash: hashInviteToken(this.config.tokenPepper, token),
      deviceLimit: input.deviceLimit ?? null,
    });
    return { invite, token };
  }

  list(): Promise<Invite[]> {
    return this.repos.invites.list();
  }

  /**
   * Replaces the code without disturbing the devices already enrolled with it.
   *
   * This is the answer to "I think my code got out": the old one stops working
   * for enrolment immediately, and nobody has to set their phone up again. It
   * does *not* remove whoever already got in — see
   * [DeviceService.revokeAllForInvite] for that, which is the other half of
   * responding to a leak.
   */
  async rotate(id: number): Promise<MintedInvite | null> {
    const token = humanCode(INVITE_CODE_LENGTH);
    const invite = await this.repos.invites.rotateToken(
      id,
      hashInviteToken(this.config.tokenPepper, token),
    );
    return invite ? { invite, token } : null;
  }

  /**
   * Resolves an invite token to the invite it belongs to.
   *
   * A revoked invite is rejected here rather than by omitting it from the
   * lookup, so the message can say which of the two it is. Both answers are
   * safe to give: presenting the token already proves you were given it.
   */
  async resolve(token: string): Promise<Invite> {
    // Normalised first, so a code typed with the dashes someone added to keep
    // their place, or with an O where the alphabet has a zero, still resolves.
    const invite = await this.repos.invites.findByTokenHash(
      hashInviteToken(this.config.tokenPepper, normalizeCode(token)),
    );
    // One answer for both "never existed" and "rotated away", because there
    // is no longer a difference: rotating replaces the hash, so the old code
    // simply does not resolve. Nothing records that it once did.
    if (!invite) throw unauthorized('That invite code is not valid.');
    return invite;
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

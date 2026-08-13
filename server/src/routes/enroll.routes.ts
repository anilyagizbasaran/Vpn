import { Router } from 'express';
import { z } from 'zod';

import type { DeviceService } from '../services/deviceService.js';
import type { InviteService } from '../services/inviteService.js';
import { peerWriteLimiter } from '../middleware/rateLimiters.js';
import { parseBody } from '../middleware/validate.js';
import { DEVICE_PLATFORMS } from '../db/types.js';
import { hasControlChars } from '../utils/validation.js';

const publicKeySchema = z
  .string()
  .regex(/^[A-Za-z0-9+/]{43}=$/, 'publicKey must be a base64-encoded 32-byte WireGuard key');

const enrolSchema = z.object({
  inviteToken: z.string().min(8, 'Enter the invite code you were given'),
  // Optional. Supplying it means the device generated the keypair itself and
  // the server never sees the private half.
  publicKey: publicKeySchema.optional(),
  label: z
    .string()
    .trim()
    .min(1, 'Device label cannot be empty')
    .max(64, 'Device label must be at most 64 characters')
    // A newline in a label would otherwise reach the rendered wg-quick config,
    // where a line of its own is a directive.
    .refine((v) => !hasControlChars(v), {
      message: 'Device label contains control characters',
    })
    .optional(),
  platform: z.enum(DEVICE_PLATFORMS).optional(),
});

/**
 * Enrolment: one call, one credential, a working config.
 *
 * This is what replaces registering and signing in. The invite proves the
 * operator let this person on; nothing about an account is involved, because
 * there is no account.
 *
 * It stays an enrolment credential and not a key: the client generates its own
 * pair and sends only the public half, exactly as the account path did, so the
 * server still holds nothing that could decrypt traffic.
 */
export function createEnrollRouter(devices: DeviceService, invites: InviteService): Router {
  const router = Router();

  // Rate limited per IP like the other write paths. Guessing an invite code is
  // not feasible — 32 random bytes — but an unlimited enrolment endpoint is an
  // unlimited device-creation endpoint for anyone holding one valid code.
  router.post('/', peerWriteLimiter, async (req, res) => {
    const body = parseBody(enrolSchema, req.body);

    const invite = await invites.resolve(body.inviteToken);
    const { token, tokenHash } = invites.mintDeviceToken();

    const result = await devices.enrolDevice(
      { inviteId: invite.id, tokenHash },
      invite.deviceLimit,
      { label: body.label ?? 'My device', publicKey: body.publicKey, platform: body.platform },
    );

    // Recorded after the device exists, so a failed enrolment does not look
    // like a successful one in the invite list.
    await invites.touch(invite.id);

    // A config carries key material; a cache anywhere on the path is a copy of
    // it nobody meant to keep.
    res.status(201).set('Cache-Control', 'no-store').json({
      ...result,
      // Shown once. It is how this device authenticates from now on; the
      // invite is not needed again and should not be kept by the client.
      deviceToken: token,
    });
  });

  return router;
}

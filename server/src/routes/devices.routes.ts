import { Router } from 'express';
import type { RequestHandler } from 'express';
import { z } from 'zod';
import { DEVICE_PLATFORMS } from '../db/types.js';
import type { DeviceService } from '../services/deviceService.js';
import { authContext } from '../middleware/requireAuth.js';
import { peerWriteLimiter } from '../middleware/rateLimiters.js';
import { parseBody, parseIdParam } from '../middleware/validate.js';

/** Control characters would corrupt log lines and the rendered .conf file. */
function hasControlChars(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

const publicKeySchema = z
  .string()
  .regex(/^[A-Za-z0-9+/]{43}=$/, 'publicKey must be a base64-encoded 32-byte WireGuard key');

const createDeviceSchema = z.object({
  label: z
    .string()
    .trim()
    .min(1, 'Device label cannot be empty')
    .max(64, 'Device label must be at most 64 characters')
    .refine((v) => !hasControlChars(v), {
      message: 'Device label contains control characters',
    })
    .default('My device'),
  // Optional. Supplying it means the device generated the keypair itself and
  // the server never sees the private half.
  publicKey: publicKeySchema.optional(),
  platform: z.enum(DEVICE_PLATFORMS).optional(),
});

const rotateKeySchema = z.object({ publicKey: publicKeySchema });

const serverQuerySchema = z.object({
  serverId: z.coerce.number().int().positive().optional(),
});

export function createDevicesRouter(devices: DeviceService, requireAuth: RequestHandler): Router {
  const router = Router();
  router.use(requireAuth);

  /**
   * Registers a device and gives it an address on every server, so switching
   * region later is a config edit rather than another registration.
   */
  router.post('/', peerWriteLimiter, async (req, res) => {
    const { userId } = authContext(req);
    const { label, publicKey, platform } = parseBody(createDeviceSchema, req.body ?? {});
    const result = await devices.createDevice(userId, { label, publicKey, platform });

    res
      .status(201)
      .set('Cache-Control', 'no-store')
      .json({
        ...result,
        // Only present when the server had to generate the keypair.
        ...(result.privateKeyIncluded
          ? {
              warning:
                'privateKey is returned once and is never stored on the server. Save it now or the device must be re-created. Prefer generating the keypair on the device and sending only publicKey.',
            }
          : {}),
      });
  });

  router.get('/', async (req, res) => {
    const { userId } = authContext(req);
    res.json({ devices: await devices.listDevices(userId) });
  });

  /**
   * The config for this device. `?serverId=` selects a region; omitting it
   * gives the default one.
   */
  router.get('/:id/config', async (req, res) => {
    const { userId } = authContext(req);
    const deviceId = parseIdParam(req.params.id);
    const { serverId } = parseBody(serverQuerySchema, req.query);

    res
      .set('Cache-Control', 'no-store')
      .json(await devices.getDeviceConfig(userId, deviceId, serverId));
  });

  router.post('/:id/rotate', peerWriteLimiter, async (req, res) => {
    const { userId } = authContext(req);
    const deviceId = parseIdParam(req.params.id);
    const { publicKey } = parseBody(rotateKeySchema, req.body ?? {});

    res
      .set('Cache-Control', 'no-store')
      .json(await devices.rotateKey(userId, deviceId, publicKey));
  });

  router.delete('/:id', peerWriteLimiter, async (req, res) => {
    const { userId } = authContext(req);
    await devices.revokeDevice(userId, parseIdParam(req.params.id));
    res.status(204).end();
  });

  return router;
}

/** The region list. Authenticated, but it exposes nothing user-specific. */
export function createServersRouter(
  devices: DeviceService,
  requireAuth: RequestHandler,
): Router {
  const router = Router();
  router.use(requireAuth);

  router.get('/', async (_req, res) => {
    res.json({ servers: await devices.listServers() });
  });

  return router;
}

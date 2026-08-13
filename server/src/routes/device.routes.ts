import { Router } from 'express';
import type { RequestHandler } from 'express';
import { z } from 'zod';

import type { DeviceService } from '../services/deviceService.js';
import { peerWriteLimiter } from '../middleware/rateLimiters.js';
import { parseBody } from '../middleware/validate.js';

const rotateSchema = z.object({
  publicKey: z.string().min(1),
});

/**
 * What an enrolled device can do to itself: read its config, replace its key,
 * and remove itself.
 *
 * Every route is about *this* device — there is no id in any path. That is not
 * a shortcut, it is the security property: a device token authenticates one
 * device, so there is no way to name another one and therefore nothing to get
 * wrong about ownership. The account routes need `requireOwnedDevice` on every
 * call for exactly the reason these do not.
 */
export function createDeviceRouter(devices: DeviceService, requireDevice: RequestHandler): Router {
  const router = Router();
  router.use(requireDevice);

  router.get('/', async (req, res) => {
    res.json({ device: (await devices.configFor(req.device!)).device });
  });

  router.get('/config', async (req, res) => {
    const serverId = req.query['serverId'] ? Number(req.query['serverId']) : undefined;
    res.set('Cache-Control', 'no-store').json(await devices.configFor(req.device!, serverId));
  });

  router.post('/rotate', peerWriteLimiter, async (req, res) => {
    const { publicKey } = parseBody(rotateSchema, req.body);
    res.set('Cache-Control', 'no-store').json(await devices.rotateKeyFor(req.device!, publicKey));
  });

  router.delete('/', peerWriteLimiter, async (req, res) => {
    await devices.revokeOwn(req.device!);
    res.status(204).end();
  });

  return router;
}

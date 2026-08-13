import { Router } from 'express';
import type { RequestHandler } from 'express';

import type { DeviceService } from '../services/deviceService.js';

/**
 * The regions a device can pick between.
 *
 * Behind the device token rather than public: the list names every node and
 * its endpoint, which is not a secret, but there is no reason to hand a
 * scanner a map of the deployment either.
 */
export function createServersRouter(
  devices: DeviceService,
  requireDevice: RequestHandler,
): Router {
  const router = Router();
  router.use(requireDevice);

  router.get('/', async (_req, res) => {
    res.json({ servers: await devices.listServers() });
  });

  return router;
}

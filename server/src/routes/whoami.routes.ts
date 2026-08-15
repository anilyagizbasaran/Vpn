import { Router } from 'express';
import type { RequestHandler } from 'express';

import type { DeviceService } from '../services/deviceService.js';

/**
 * The address the internet sees for you, answered by your own server.
 *
 * The alternative is what most VPN clients do: ask ipify, ifconfig.me or
 * whoever. That hands your real address to a third party every time the app
 * opens, which is an odd thing for a VPN to arrange. The server terminating
 * the tunnel already sees the address by necessity, so it is the one place
 * that learns nothing new by being asked.
 *
 * Nothing here is written down. The address is read off the request, compared
 * against the node pools, and returned. It is not logged, not stored, and the
 * rate limiter above it records the path rather than the caller.
 */
export function createWhoamiRouter(
  devices: DeviceService,
  requireDevice: RequestHandler,
): Router {
  const router = Router();
  router.use(requireDevice);

  router.get('/', async (req, res) => {
    // `trust proxy` is set from TRUST_PROXY, so behind Caddy or nginx this is
    // the client's address rather than the proxy's. Getting that wrong would
    // show everybody the loopback address and look like a bug in the tunnel.
    const seen = normalise(req.ip ?? '');

    res.set('Cache-Control', 'no-store').json(await devices.whereFrom(seen));
  });

  return router;
}

/** `::ffff:1.2.3.4` is how Node reports IPv4 on a dual-stack socket. */
function normalise(address: string): string {
  return address.startsWith('::ffff:') ? address.slice(7) : address;
}

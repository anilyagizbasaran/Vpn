import { Router } from 'express';
import type { RequestHandler } from 'express';
import { z } from 'zod';
import { DEVICE_PLATFORMS } from '../db/types.js';
import type { PeerService } from '../services/peerService.js';
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

/**
 * A WireGuard public key: 32 bytes, base64. Only the format is checked here;
 * `PeerService` re-validates before anything reaches the interface.
 */
const publicKeySchema = z
  .string()
  .regex(/^[A-Za-z0-9+/]{43}=$/, 'publicKey must be a base64-encoded 32-byte WireGuard key');

const createPeerSchema = z.object({
  deviceLabel: z
    .string()
    .trim()
    .min(1, 'Device label cannot be empty')
    .max(64, 'Device label must be at most 64 characters')
    .refine((v) => !hasControlChars(v), {
      message: 'Device label contains control characters',
    })
    .default('My device'),
  // Optional. Supplying it means the device generated the keypair itself and
  // the server never sees the private half. Omitting it falls back to
  // server-side generation, which returns the private key once.
  publicKey: publicKeySchema.optional(),
  // A closed set, because it selects an icon in the device list. An older
  // client that does not send one gets `unknown` rather than a rejection.
  platform: z.enum(DEVICE_PLATFORMS).optional(),
});

const rotateKeySchema = z.object({ publicKey: publicKeySchema });

export function createPeersRouter(peers: PeerService, requireAuth: RequestHandler): Router {
  const router = Router();
  router.use(requireAuth);

  router.post('/', peerWriteLimiter, async (req, res) => {
    const { userId } = authContext(req);
    const { deviceLabel, publicKey, platform } = parseBody(createPeerSchema, req.body ?? {});
    const result = await peers.createPeer(userId, { deviceLabel, publicKey, platform });

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

  /**
   * Replaces the device's keypair, keeping its id and tunnel address. Run
   * periodically by the app so a leaked config stops working on its own.
   */
  router.post('/:id/rotate', peerWriteLimiter, async (req, res) => {
    const { userId } = authContext(req);
    const peerId = parseIdParam(req.params.id);
    const { publicKey } = parseBody(rotateKeySchema, req.body ?? {});

    res
      .set('Cache-Control', 'no-store')
      .json(await peers.rotatePeerKey(userId, peerId, publicKey));
  });

  router.get('/', async (req, res) => {
    const { userId } = authContext(req);
    res.json({ peers: await peers.listPeers(userId) });
  });

  router.get('/:id/config', async (req, res) => {
    const { userId } = authContext(req);
    const peerId = parseIdParam(req.params.id);
    res.set('Cache-Control', 'no-store').json(await peers.getPeerConfig(userId, peerId));
  });

  router.delete('/:id', peerWriteLimiter, async (req, res) => {
    const { userId } = authContext(req);
    const peerId = parseIdParam(req.params.id);
    await peers.revokePeer(userId, peerId);
    res.status(204).end();
  });

  return router;
}

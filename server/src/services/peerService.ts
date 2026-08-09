import type { Repositories } from '../db/repositories.js';
import type { Peer, VpnServer } from '../db/types.js';
import { UniqueConstraintError } from '../db/types.js';
import { decryptSecret, encryptSecret } from '../utils/crypto.js';
import { logger } from '../utils/logger.js';
import { badRequest, conflict, notFound, quotaExceeded, wireguardFailure } from '../utils/errors.js';
import { isWireGuardKey } from '../utils/validation.js';
import { allocateAddress, PoolExhaustedError } from './ipam.js';
import { renderWgQuickConfig } from './configRenderer.js';
import type { WireGuardController } from './wireguard/index.js';

export interface PeerServiceConfig {
  maxPeersPerUser: number;
  enablePresharedKey: boolean;
  /** 64 hex chars; only read when `enablePresharedKey` is true. */
  pskEncryptionKey: string;
  clientAllowedIps: string;
  persistentKeepalive: number;
  clientMtu: number;
}

export interface CreatePeerRequest {
  deviceLabel: string;
  /**
   * The public half of a keypair generated on the device. When present the
   * server generates nothing and never sees a private key.
   */
  publicKey?: string | undefined;
  platform?: string | undefined;
}

export interface PeerView {
  id: number;
  deviceLabel: string;
  platform: string;
  publicKey: string;
  allowedIp: string;
  serverId: number;
  region: string;
  endpoint: string;
  createdAt: string;
  /** Null until the device rotates for the first time. */
  keyRotatedAt: string | null;
}

export interface PeerConfigView {
  peer: PeerView;
  server: {
    publicKey: string;
    endpoint: string;
    dns: string;
    allowedIps: string;
    persistentKeepalive: number;
    mtu: number;
  };
  presharedKey: string | null;
  /** Present exactly once, in the POST /peers response. Never stored. */
  privateKey: string | null;
  /**
   * Full wg-quick config. When `privateKeyIncluded` is false the PrivateKey
   * line holds the literal `<PRIVATE_KEY>` placeholder and the client must
   * substitute the key it saved at creation time.
   */
  conf: string;
  privateKeyIncluded: boolean;
}

const MAX_ADDRESS_RETRIES = 6;

export class PeerService {
  constructor(
    private readonly repos: Repositories,
    private readonly wg: WireGuardController,
    private readonly config: PeerServiceConfig,
  ) {}

  private toView(peer: Peer, server: VpnServer): PeerView {
    return {
      id: peer.id,
      deviceLabel: peer.deviceLabel,
      platform: peer.platform,
      publicKey: peer.publicKey,
      allowedIp: peer.allowedIp,
      serverId: server.id,
      region: server.region,
      endpoint: server.endpoint,
      createdAt: peer.createdAt,
      keyRotatedAt: peer.keyRotatedAt,
    };
  }

  private async requireDefaultServer(): Promise<VpnServer> {
    const server = await this.repos.servers.getDefault();
    if (!server) {
      throw wireguardFailure('No VPN server is configured on the control plane');
    }
    return server;
  }

  private async requireOwnedPeer(userId: number, peerId: number): Promise<Peer> {
    const peer = await this.repos.peers.findById(peerId);
    // A peer belonging to somebody else is reported as missing, so the API
    // cannot be used to probe which peer ids exist.
    if (!peer || peer.userId !== userId) throw notFound('Peer not found');
    return peer;
  }

  private decryptPsk(peer: Peer): string | null {
    if (!peer.presharedKeyEnc) return null;
    try {
      return decryptSecret(this.config.pskEncryptionKey, peer.presharedKeyEnc);
    } catch (error) {
      logger.error('failed to decrypt preshared key', {
        peerId: peer.id,
        error: error instanceof Error ? error.message : String(error),
      });
      throw wireguardFailure('Stored preshared key could not be decrypted');
    }
  }

  private buildConfigView(
    peer: Peer,
    server: VpnServer,
    privateKey: string | null,
    presharedKey: string | null,
  ): PeerConfigView {
    return {
      peer: this.toView(peer, server),
      server: {
        publicKey: server.publicKey,
        endpoint: server.endpoint,
        dns: server.dns,
        allowedIps: this.config.clientAllowedIps,
        persistentKeepalive: this.config.persistentKeepalive,
        mtu: this.config.clientMtu,
      },
      presharedKey,
      privateKey,
      conf: renderWgQuickConfig({
        privateKey,
        address: peer.allowedIp,
        dns: server.dns,
        serverPublicKey: server.publicKey,
        presharedKey,
        allowedIps: this.config.clientAllowedIps,
        endpoint: server.endpoint,
        persistentKeepalive: this.config.persistentKeepalive,
        mtu: this.config.clientMtu,
      }),
      privateKeyIncluded: privateKey !== null,
    };
  }

  async listPeers(userId: number): Promise<PeerView[]> {
    const peers = await this.repos.peers.listActiveByUser(userId);
    const servers = new Map((await this.repos.servers.list()).map((s) => [s.id, s]));
    return peers.flatMap((peer) => {
      const server = servers.get(peer.serverId);
      return server ? [this.toView(peer, server)] : [];
    });
  }

  /**
   * Creates a peer and returns its private key — the only time that key ever
   * exists on the server. It is generated, handed to the caller, and dropped;
   * only the public key reaches the database.
   */
  async createPeer(userId: number, input: CreatePeerRequest): Promise<PeerConfigView> {
    const { deviceLabel, publicKey: clientPublicKey, platform = 'unknown' } = input;

    const active = await this.repos.peers.countActiveByUser(userId);
    if (active >= this.config.maxPeersPerUser) {
      throw quotaExceeded(
        `Device limit reached (${this.config.maxPeersPerUser}). Remove a device before adding a new one.`,
        { limit: this.config.maxPeersPerUser, active },
      );
    }

    const server = await this.requireDefaultServer();

    // Preferred path: the device generated the keypair itself and sent only
    // the public half, so the private key never exists on this machine at all
    // — not in memory, not in a response body, not in a crash dump.
    // Server-side generation stays as a fallback for clients that cannot do
    // Curve25519 (curl, scripts, older app builds).
    if (clientPublicKey !== undefined && !isWireGuardKey(clientPublicKey)) {
      throw badRequest('publicKey must be a base64-encoded 32-byte WireGuard key');
    }

    let keys = clientPublicKey
      ? { privateKey: null, publicKey: clientPublicKey }
      : await this.wg.generateKeyPair();

    const presharedKey = this.config.enablePresharedKey
      ? await this.wg.generatePresharedKey()
      : null;
    const presharedKeyEnc = presharedKey
      ? encryptSecret(this.config.pskEncryptionKey, presharedKey)
      : null;

    // The database row is written first: it reserves the address under the
    // partial UNIQUE index, so two concurrent requests can never be handed the
    // same IP. A lost race surfaces as UniqueConstraintError and we retry with
    // a freshly computed address.
    let peer: Peer | null = null;
    for (let attempt = 0; attempt < MAX_ADDRESS_RETRIES && peer === null; attempt += 1) {
      let allowedIp: string;
      try {
        allowedIp = allocateAddress({
          poolCidr: server.addressPoolCidr,
          reserved: [server.serverAddress],
          taken: await this.repos.peers.activeAllowedIps(server.id),
        });
      } catch (error) {
        if (error instanceof PoolExhaustedError) {
          logger.error('address pool exhausted', { serverId: server.id, pool: server.addressPoolCidr });
          throw conflict('This server has no free addresses left. Try again later.');
        }
        throw error;
      }

      try {
        peer = await this.repos.peers.create({
          userId,
          serverId: server.id,
          publicKey: keys.publicKey,
          presharedKeyEnc,
          allowedIp,
          deviceLabel,
          platform,
        });
      } catch (error) {
        if (!(error instanceof UniqueConstraintError)) throw error;
        if (error.constraintHint === 'public_key') {
          // A client-supplied key that is already in use is the caller's
          // problem — regenerating it here would hand them a key they have no
          // private half for. Only server-generated keys can be retried.
          if (clientPublicKey) {
            throw conflict('That public key is already registered on this server');
          }
          // Practically impossible for Curve25519, but cheap to handle.
          keys = await this.wg.generateKeyPair();
        }
        logger.warn('peer insert lost a race, retrying', {
          userId,
          attempt: attempt + 1,
          reason: error.constraintHint,
        });
      }
    }

    if (!peer) {
      throw conflict('Could not allocate an address after several attempts. Try again.');
    }

    try {
      await this.wg.addPeer({
        publicKey: peer.publicKey,
        allowedIps: [peer.allowedIp],
        presharedKey: presharedKey ?? undefined,
      });
    } catch (error) {
      // Compensating action: release the reservation so the address does not
      // leak out of the pool. If this revoke also fails, the boot-time sync
      // still converges because the database stays the source of truth.
      await this.repos.peers.revoke(peer.id, new Date().toISOString()).catch(() => undefined);
      logger.error('failed to add peer to interface, reservation released', {
        peerId: peer.id,
        error: error instanceof Error ? error.message : String(error),
      });
      throw wireguardFailure('Could not register the device on the VPN server');
    }

    logger.info('peer created', { userId, peerId: peer.id, allowedIp: peer.allowedIp });
    return this.buildConfigView(peer, server, keys.privateKey, presharedKey);
  }

  /**
   * Replaces a device's keypair without changing its identity or address.
   *
   * This is what makes a stolen config expire on its own: the old public key
   * stops being routable the moment the new one takes over, so a leaked
   * config is only useful until the next rotation. The device keeps its id,
   * label and tunnel IP, so nothing else in the account has to change.
   *
   * The client generates the new keypair and sends only the public half.
   */
  async rotatePeerKey(
    userId: number,
    peerId: number,
    newPublicKey: string,
  ): Promise<PeerConfigView> {
    if (!isWireGuardKey(newPublicKey)) {
      throw badRequest('publicKey must be a base64-encoded 32-byte WireGuard key');
    }

    const peer = await this.requireOwnedPeer(userId, peerId);
    if (peer.revokedAt) throw notFound('Peer has been revoked');

    const server = await this.repos.servers.findById(peer.serverId);
    if (!server) throw wireguardFailure('The server this peer belongs to is no longer configured');

    if (peer.publicKey === newPublicKey) {
      throw conflict('That key is already the active key for this device');
    }

    const previousPublicKey = peer.publicKey;
    const presharedKey = this.decryptPsk(peer);

    let rotated: Peer;
    try {
      rotated = await this.repos.peers.rotateKey(peer.id, newPublicKey, new Date().toISOString());
    } catch (error) {
      if (error instanceof UniqueConstraintError) {
        throw conflict('That public key is already registered on this server');
      }
      throw error;
    }

    try {
      await this.wg.replacePeer(previousPublicKey, {
        publicKey: rotated.publicKey,
        allowedIps: [rotated.allowedIp],
        presharedKey: presharedKey ?? undefined,
      });
    } catch (error) {
      // Roll the database back to the key that is still live on the interface,
      // otherwise the device would hold a key the server never accepted while
      // the database insists it is current.
      await this.repos.peers
        .rotateKey(peer.id, previousPublicKey, peer.keyRotatedAt ?? peer.createdAt)
        .catch(() => undefined);

      logger.error('key rotation failed, reverted to the previous key', {
        peerId: peer.id,
        error: error instanceof Error ? error.message : String(error),
      });
      throw wireguardFailure('Could not install the new key on the VPN server. Keep using the old one.');
    }

    logger.info('peer key rotated', { userId, peerId: peer.id });
    return this.buildConfigView(rotated, server, null, presharedKey);
  }

  async getPeerConfig(userId: number, peerId: number): Promise<PeerConfigView> {
    const peer = await this.requireOwnedPeer(userId, peerId);
    if (peer.revokedAt) throw notFound('Peer has been revoked');

    const server = await this.repos.servers.findById(peer.serverId);
    if (!server) throw wireguardFailure('The server this peer belongs to is no longer configured');

    return this.buildConfigView(peer, server, null, this.decryptPsk(peer));
  }

  /**
   * Revokes in the database first, then removes the key from the interface.
   * That order is deliberate: if the second step fails, the boot-time sync
   * removes the peer, whereas the reverse order could resurrect a revoked key.
   */
  async revokePeer(userId: number, peerId: number): Promise<void> {
    const peer = await this.requireOwnedPeer(userId, peerId);

    if (!peer.revokedAt) {
      await this.repos.peers.revoke(peer.id, new Date().toISOString());
    }

    try {
      await this.wg.removePeer(peer.publicKey);
    } catch (error) {
      logger.error('peer revoked in database but interface removal failed', {
        peerId: peer.id,
        error: error instanceof Error ? error.message : String(error),
      });
      throw wireguardFailure(
        'Device was revoked but the VPN server did not confirm removal. Retry this request.',
      );
    }

    logger.info('peer revoked', { userId, peerId: peer.id });
  }

  /**
   * Removes every one of a user's peers from the interface. Used by account
   * deletion, where the database rows disappear via CASCADE — so the keys must
   * come off the interface first or they would survive with nothing left to
   * describe them, and the boot sync could never clean them up.
   *
   * Returns the keys it failed to remove; the caller decides whether losing
   * them is acceptable.
   */
  async removeAllPeersFromInterface(userId: number): Promise<string[]> {
    const peers = await this.repos.peers.listActiveByUser(userId);
    const failed: string[] = [];

    for (const peer of peers) {
      try {
        await this.wg.removePeer(peer.publicKey);
      } catch (error) {
        failed.push(peer.publicKey);
        logger.error('could not remove peer from interface', {
          peerId: peer.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return failed;
  }

  /** Re-applies every live peer onto the interface. Run at boot. */
  async syncInterface(): Promise<{ added: number; removed: number }> {
    const server = await this.repos.servers.getDefault();
    if (!server) return { added: 0, removed: 0 };

    const peers = await this.repos.peers.listActiveByServer(server.id);
    const result = await this.wg.sync(
      peers.map((peer) => ({
        publicKey: peer.publicKey,
        allowedIps: [peer.allowedIp],
        presharedKey: this.decryptPsk(peer) ?? undefined,
      })),
    );

    logger.info('interface synced from database', {
      interface: this.wg.interfaceName,
      active: peers.length,
      ...result,
    });
    return result;
  }
}

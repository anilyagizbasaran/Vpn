import type { Repositories } from '../db/repositories.js';
import type { Device, Peer, VpnServer } from '../db/types.js';
import { UniqueConstraintError } from '../db/types.js';
import { decryptSecret, encryptSecret } from '../utils/crypto.js';
import { logger } from '../utils/logger.js';
import {
  badRequest,
  conflict,
  notFound,
  quotaExceeded,
  unprocessable,
} from '../utils/errors.js';
import { isWireGuardKey } from '../utils/validation.js';
import { allocateAddress, PoolExhaustedError } from './ipam.js';
import { renderWgQuickConfig } from './configRenderer.js';
import { generateKeyPair, generatePresharedKey } from './keys.js';

export interface DeviceServiceConfig {
  enablePresharedKey: boolean;
  /** 64 hex chars; only read when `enablePresharedKey` is true. */
  pskEncryptionKey: string;
  clientAllowedIps: string;
  persistentKeepalive: number;
  clientMtu: number;
}

export interface ServerView {
  id: number;
  region: string;
  displayName: string;
  endpoint: string;
  isDefault: boolean;
  /** False for a node that has stopped reporting; the app should hide it. */
  online: boolean;
}

/** One server this device can reach, with the address it holds there. */
export interface DeviceLocationView {
  serverId: number;
  region: string;
  displayName: string;
  endpoint: string;
  allowedIp: string;
  online: boolean;
}

export interface DeviceView {
  id: number;
  label: string;
  platform: string;
  publicKey: string;
  createdAt: string;
  keyRotatedAt: string | null;
  locations: DeviceLocationView[];
  usage: { rxBytes: number; txBytes: number };
}

export interface DeviceConfigView {
  device: DeviceView;
  server: {
    id: number;
    region: string;
    publicKey: string;
    endpoint: string;
    dns: string;
    allowedIps: string;
    persistentKeepalive: number;
    mtu: number;
  };
  presharedKey: string | null;
  /** Present only when the *server* generated the keypair. Never stored. */
  privateKey: string | null;
  conf: string;
  privateKeyIncluded: boolean;
}

export interface CreateDeviceRequest {
  label: string;
  /**
   * The public half of a keypair generated on the device. When present the
   * server generates nothing and never sees a private key.
   */
  publicKey?: string | undefined;
  platform?: string | undefined;
}

/** A node that has not reported in this long is treated as offline. */
const OFFLINE_AFTER_MS = 3 * 60 * 1000;

const MAX_ADDRESS_RETRIES = 6;

export class DeviceService {
  constructor(
    private readonly repos: Repositories,
    private readonly config: DeviceServiceConfig,
  ) {}

  private isOnline(server: VpnServer, now = Date.now()): boolean {
    if (server.status === 'offline') return false;
    if (!server.lastSeenAt) return false;
    return now - Date.parse(server.lastSeenAt) < OFFLINE_AFTER_MS;
  }

  private toServerView(server: VpnServer): ServerView {
    return {
      id: server.id,
      region: server.region,
      displayName: server.displayName,
      endpoint: server.endpoint,
      isDefault: server.isDefault,
      online: this.isOnline(server),
    };
  }

  /** The region list the app shows. Draining nodes are hidden from new picks. */
  async listServers(): Promise<ServerView[]> {
    const servers = await this.repos.servers.listAllocatable();
    return servers.map((server) => this.toServerView(server));
  }

  private decryptPsk(peer: Peer): string | null {
    if (!peer.presharedKeyEnc) return null;
    return decryptSecret(this.config.pskEncryptionKey, peer.presharedKeyEnc);
  }

  private async toDeviceView(device: Device): Promise<DeviceView> {
    const [peers, servers, usage] = await Promise.all([
      this.repos.peers.listActiveByDevice(device.id),
      this.repos.servers.list(),
      this.repos.usage.totalsForDevice(device.id),
    ]);

    const byId = new Map(servers.map((server) => [server.id, server]));
    const now = Date.now();

    return {
      id: device.id,
      label: device.label,
      platform: device.platform,
      publicKey: device.publicKey,
      createdAt: device.createdAt,
      keyRotatedAt: device.keyRotatedAt,
      usage,
      locations: peers.flatMap((peer) => {
        const server = byId.get(peer.serverId);
        if (!server) return [];
        return [
          {
            serverId: server.id,
            region: server.region,
            displayName: server.displayName,
            endpoint: server.endpoint,
            allowedIp: peer.allowedIp,
            online: this.isOnline(server, now),
          },
        ];
      }),
    };
  }

  /**
   * Allocates an address for a device on one server, retrying when a
   * concurrent request takes the address first.
   *
   * The database row is the reservation: the partial UNIQUE index on
   * (server_id, allowed_ip) is what makes two simultaneous requests safe, and
   * the loser retries with a freshly computed address.
   */
  private async allocateOn(server: VpnServer, deviceId: number): Promise<Peer> {
    const existing = await this.repos.peers.findActiveForDeviceOnServer(deviceId, server.id);
    if (existing) return existing;

    const presharedKeyEnc = this.config.enablePresharedKey
      ? encryptSecret(this.config.pskEncryptionKey, generatePresharedKey())
      : null;

    for (let attempt = 0; attempt < MAX_ADDRESS_RETRIES; attempt += 1) {
      let allowedIp: string;
      try {
        allowedIp = allocateAddress({
          poolCidr: server.addressPoolCidr,
          reserved: [server.serverAddress],
          taken: await this.repos.peers.activeAllowedIps(server.id),
        });
      } catch (error) {
        if (error instanceof PoolExhaustedError) {
          logger.error('address pool exhausted', {
            serverId: server.id,
            region: server.region,
            pool: server.addressPoolCidr,
          });
          throw conflict(`The ${server.displayName} server has no free addresses left.`);
        }
        throw error;
      }

      try {
        return await this.repos.peers.create({
          deviceId,
          serverId: server.id,
          allowedIp,
          presharedKeyEnc,
        });
      } catch (error) {
        if (!(error instanceof UniqueConstraintError)) throw error;
        if (error.constraintHint === 'device_server') {
          // Another request allocated for this device first; use theirs.
          const raced = await this.repos.peers.findActiveForDeviceOnServer(deviceId, server.id);
          if (raced) return raced;
        }
        logger.warn('peer insert lost a race, retrying', {
          serverId: server.id,
          deviceId,
          attempt: attempt + 1,
          reason: error.constraintHint,
        });
      }
    }

    throw conflict('Could not allocate an address after several attempts. Try again.');
  }

  /**
   * Registers a device and gives it an address on every allocatable server.
   *
   * Every server, not just the default: switching region then costs the client
   * one line of its config rather than a round trip, and the quota keeps
   * counting devices instead of device-region pairs.
   *
   * This is the only way a device comes into existence. There is no second
   * path — the account one is gone — so quota, addressing and key ownership
   * are decided in exactly one place and cannot drift apart.
   */
  async enrolDevice(
    owner: { inviteId: number; tokenHash: string },
    limit: number,
    input: CreateDeviceRequest,
  ): Promise<DeviceConfigView> {
    const active = await this.repos.devices.countActiveByInvite(owner.inviteId);
    if (active >= limit) {
      throw quotaExceeded(
        `Device limit reached (${limit}). Remove a device before adding a new one.`,
        { limit, active },
      );
    }

    if (input.publicKey !== undefined && !isWireGuardKey(input.publicKey)) {
      throw badRequest('publicKey must be a base64-encoded 32-byte WireGuard key');
    }

    const servers = await this.repos.servers.listAllocatable();
    if (servers.length === 0) {
      throw unprocessable('No VPN server is available. Try again shortly.');
    }

    // Preferred path: the device generated the keypair itself, so the private
    // key never exists on this machine at all — not in memory, not in a
    // response body, not in a crash dump. Server-side generation stays as a
    // fallback for clients that cannot do Curve25519 (curl, scripts).
    const generated = input.publicKey ? null : generateKeyPair();
    const publicKey = input.publicKey ?? generated!.publicKey;

    let device: Device;
    try {
      device = await this.repos.devices.create({
        ...owner,
        label: input.label,
        platform: input.platform ?? 'unknown',
        publicKey,
      });
    } catch (error) {
      if (error instanceof UniqueConstraintError) {
        // Regenerating here would hand the caller a key they have no private
        // half for, so a client-supplied clash has to surface as an error.
        throw conflict('That public key is already registered');
      }
      throw error;
    }

    for (const server of servers) {
      await this.allocateOn(server, device.id);
    }

    logger.info('device registered', {
      inviteId: owner.inviteId,
      deviceId: device.id,
      servers: servers.length,
      clientKeygen: input.publicKey !== undefined,
    });

    const home = servers.find((server) => server.isDefault) ?? servers[0]!;
    return this.buildConfig(device, home, generated?.privateKey ?? null);
  }

  private async buildConfig(
    device: Device,
    server: VpnServer,
    privateKey: string | null,
  ): Promise<DeviceConfigView> {
    const peer = await this.repos.peers.findActiveForDeviceOnServer(device.id, server.id);
    if (!peer) {
      throw notFound(`This device has no address on ${server.displayName}`);
    }

    const presharedKey = this.decryptPsk(peer);

    return {
      device: await this.toDeviceView(device),
      server: {
        id: server.id,
        region: server.region,
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

  /**
   * What an enrolled device may do to itself: read its config, replace its key,
   * remove itself.
   *
   * Thin on purpose. The middleware has already resolved the device from its
   * token, so there is no ownership left to check — a device token names one
   * device and cannot name another, which is why these take a [Device] and not
   * an id.
   */
  configFor(device: Device, serverId?: number): Promise<DeviceConfigView> {
    return this.buildConfigFor(device, serverId);
  }

  rotateKeyFor(device: Device, newPublicKey: string): Promise<DeviceConfigView> {
    return this.rotate(device, newPublicKey);
  }

  revokeOwn(device: Device): Promise<void> {
    return this.revoke(device);
  }

  private async buildConfigFor(device: Device, serverId?: number): Promise<DeviceConfigView> {
    const server = serverId
      ? await this.repos.servers.findById(serverId)
      : ((await this.repos.servers.getDefault()) ??
        (await this.repos.servers.listAllocatable())[0] ??
        null);

    if (!server) throw notFound('That server does not exist');

    // A device created before this server existed has no address on it yet.
    await this.allocateOn(server, device.id);
    return this.buildConfig(device, server, null);
  }

  /**
   * Replaces the device's keypair, keeping its identity and every address it
   * holds. This is what makes a leaked config expire on its own.
   *
   * Note the propagation model: the control plane only updates the database.
   * Nodes pick the change up on their next sync, so the old key keeps working
   * for up to one poll interval. That window is the price of not giving the
   * control plane root on every node.
   */
  private async rotate(device: Device, newPublicKey: string): Promise<DeviceConfigView> {
    if (!isWireGuardKey(newPublicKey)) {
      throw badRequest('publicKey must be a base64-encoded 32-byte WireGuard key');
    }

    if (device.publicKey === newPublicKey) {
      throw conflict('That key is already the active key for this device');
    }

    let rotated: Device;
    try {
      rotated = await this.repos.devices.rotateKey(
        device.id,
        newPublicKey,
        new Date().toISOString(),
      );
    } catch (error) {
      if (error instanceof UniqueConstraintError) {
        throw conflict('That public key is already registered');
      }
      throw error;
    }

    logger.info('device key rotated', { deviceId: device.id });

    const server =
      (await this.repos.servers.getDefault()) ??
      (await this.repos.servers.listAllocatable())[0]!;
    return this.buildConfig(rotated, server, null);
  }

  private async revoke(device: Device): Promise<void> {
    const at = new Date().toISOString();

    // Peers first: a revoked device with live peer rows would keep its
    // addresses reserved, and the agent query filters on both anyway.
    const released = await this.repos.peers.revokeAllForDevice(device.id, at);
    await this.repos.devices.revoke(device.id, at);

    logger.info('device revoked', { deviceId: device.id, addressesReleased: released });
  }
}

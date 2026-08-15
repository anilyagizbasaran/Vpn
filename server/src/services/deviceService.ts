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
import { isInCidr, parseCidr } from '../utils/ip.js';
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

/**
 * What a device is told about itself: its key and where it can connect.
 *
 * No name, no platform, no dates and no byte counters. The server does not
 * know any of it, which is the point — a device list that could say "Ali's
 * phone, 4 GB last week" is a record somebody can be asked to hand over.
 */
export interface DeviceView {
  id: number;
  publicKey: string;
  locations: DeviceLocationView[];
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
  /**
   * The public half of a keypair generated on the device. When present the
   * server generates nothing and never sees a private key.
   */
  publicKey?: string | undefined;
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

  /**
   * Where a request reached us from, as the client should understand it.
   *
   * Two cases, and telling them apart is the whole value. A request whose
   * source address falls inside a node's tunnel pool arrived *through* that
   * node, so the address the rest of the internet sees for that client is the
   * node's own — which is the answer somebody checking their VPN wants. Any
   * other address is the client's real one, seen directly.
   *
   * Nothing is stored. This reads the request, compares it against the pools,
   * and answers.
   */
  async whereFrom(seen: string): Promise<{
    ip: string;
    throughTunnel: boolean;
    region: string | null;
  }> {
    for (const server of await this.repos.servers.list()) {
      let pool;
      try {
        pool = parseCidr(server.addressPoolCidr);
      } catch {
        continue;
      }
      if (!isInCidr(seen, pool)) continue;

      // The endpoint is `host:port` as clients dial it, and on a node that
      // masquerades — which is every node here — the host it is dialled on is
      // the address its traffic leaves from.
      const host = server.endpoint.includes(':')
        ? server.endpoint.slice(0, server.endpoint.lastIndexOf(':'))
        : server.endpoint;

      return { ip: host, throughTunnel: true, region: server.displayName };
    }

    return { ip: seen, throughTunnel: false, region: null };
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
    const [peers, servers] = await Promise.all([
      this.repos.peers.listActiveByDevice(device.id),
      this.repos.servers.list(),
    ]);

    const byId = new Map(servers.map((server) => [server.id, server]));
    const now = Date.now();

    return {
      id: device.id,
      publicKey: device.publicKey,
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
    limit: number | null,
    input: CreateDeviceRequest,
  ): Promise<DeviceConfigView> {
    // A null limit is the ordinary case now. What still bounds enrolment is
    // the address pool, which answers with a 409 of its own, and a leaked code
    // is answered by rotating it rather than by a number chosen in advance.
    if (limit !== null) {
      const active = await this.repos.devices.countActiveByInvite(owner.inviteId);
      if (active >= limit) {
        throw quotaExceeded(
          `Device limit reached (${limit}). Remove a device with \`vpn revoke\` first.`,
          { limit, active },
        );
      }
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
      device = await this.repos.devices.create({ ...owner, publicKey });
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
      rotated = await this.repos.devices.rotateKey(device.id, newPublicKey);
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

  /**
   * Every live device enrolled with an invite, in enrolment order. The
   * operator's view of who is on the server — there is no other.
   */
  async listForInvite(inviteId: number): Promise<DeviceView[]> {
    const devices = await this.repos.devices.listActiveByInvite(inviteId);
    return Promise.all(devices.map((device) => this.toDeviceView(device)));
  }

  /**
   * Cuts off every device an invite let in.
   *
   * The other half of revoking a code, and the half that was missing. Marking
   * an invite dead stops further enrolment and nothing else: the devices
   * already through it hold their own tokens and stay on the interface. An
   * operator who revoked a leaked code and stopped there would have been told
   * the leak was handled while the tunnel stayed up.
   */
  async revokeAllForInvite(inviteId: number): Promise<number> {
    const devices = await this.repos.devices.listActiveByInvite(inviteId);
    for (const device of devices) await this.revoke(device);
    return devices.length;
  }

  private async revoke(device: Device): Promise<void> {
    // Peers first, then the device. The cascade would take them anyway; doing
    // it explicitly keeps the address count honest in the log line below, and
    // that line says how many addresses came back — not which, or whose.
    const released = await this.repos.peers.revokeAllForDevice(device.id);
    await this.repos.devices.revoke(device.id);

    logger.info('device removed', { addressesReleased: released });
  }
}

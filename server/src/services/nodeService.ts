import type { Repositories, UsageReport } from '../db/repositories.js';
import type { VpnServer } from '../db/types.js';
import { decryptSecret, hmac } from '../utils/crypto.js';
import { logger } from '../utils/logger.js';
import { unauthorized } from '../utils/errors.js';

/**
 * Domain separator so a node token and a refresh token can never be confused,
 * even though they are peppered with the same secret.
 */
const NODE_TOKEN_DOMAIN = 'node:';

export function hashNodeToken(pepper: string, token: string): string {
  return hmac(pepper, NODE_TOKEN_DOMAIN + token);
}

export interface NodeServiceConfig {
  tokenPepper: string;
  pskEncryptionKey: string;
  /**
   * How long an agent waits before syncing again.
   *
   * This is also the worst-case delay before a revoked device stops working,
   * because the control plane no longer pushes anything — it only answers.
   * Ten seconds is short enough that a stolen phone is cut off while the user
   * is still looking at the screen, and long enough that a hundred nodes cost
   * ten requests a second between them.
   */
  pollSeconds: number;
}

export interface AgentSyncRequest {
  interfacePublicKey: string;
  agentVersion: string;
  usage: UsageReport[];
}

export interface AgentPeer {
  publicKey: string;
  allowedIps: string[];
  presharedKey?: string;
}

export interface AgentSyncResponse {
  server: {
    id: number;
    region: string;
    interfaceName: string;
    listenPort: number;
    addressPool: string;
    serverAddress: string;
  };
  peers: AgentPeer[];
  pollAfterSeconds: number;
}

/**
 * The node side of the control plane.
 *
 * Agents pull; the control plane never dials out. That is what lets nodes sit
 * behind a firewall with only the WireGuard port open, and it means the
 * control plane holds no credential that grants root anywhere — a push model
 * would need exactly that.
 */
export class NodeService {
  constructor(
    private readonly repos: Repositories,
    private readonly config: NodeServiceConfig,
  ) {}

  /** Resolves a bearer token to the node it belongs to. */
  async authenticate(token: string): Promise<VpnServer> {
    const server = await this.repos.servers.findByAgentTokenHash(
      hashNodeToken(this.config.tokenPepper, token),
    );
    if (!server) throw unauthorized('Unknown node token');
    return server;
  }

  async sync(server: VpnServer, request: AgentSyncRequest): Promise<AgentSyncResponse> {
    const observedAt = new Date().toISOString();

    if (request.usage.length > 0) {
      await this.repos.usage.record(server.id, request.usage, observedAt);
    }

    await this.repos.servers.recordHeartbeat({
      id: server.id,
      agentVersion: request.agentVersion,
      reportedPublicKey: request.interfacePublicKey,
      seenAt: observedAt,
    });

    // A node rebuilt from scratch comes back with a new interface key while
    // the database still hands clients the old one. Every config issued for
    // this region would then be unable to handshake, and nothing else would
    // report it.
    if (server.publicKey && request.interfacePublicKey !== server.publicKey) {
      logger.error('node interface key does not match the configured key', {
        serverId: server.id,
        region: server.region,
        configured: server.publicKey,
        reported: request.interfacePublicKey,
      });
    }

    const peers = await this.repos.peers.listActiveByServerWithDevice(server.id);

    return {
      server: {
        id: server.id,
        region: server.region,
        interfaceName: server.interfaceName,
        listenPort: server.listenPort,
        addressPool: server.addressPoolCidr,
        serverAddress: server.serverAddress,
      },
      peers: peers.map((peer) => ({
        publicKey: peer.publicKey,
        allowedIps: [peer.allowedIp],
        ...(peer.presharedKeyEnc
          ? { presharedKey: decryptSecret(this.config.pskEncryptionKey, peer.presharedKeyEnc) }
          : {}),
      })),
      pollAfterSeconds: this.config.pollSeconds,
    };
  }
}

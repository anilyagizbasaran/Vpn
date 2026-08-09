import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { logger } from '../../utils/logger.js';
import type { DesiredPeer, SyncResult, WireGuardController, WireGuardKeyPair } from './types.js';

/**
 * In-process stand-in for the `wg` CLI so the API runs on a dev machine that
 * has no WireGuard installed. Keys are *real* Curve25519 pairs (Node's X25519
 * primitives), so a config produced in mock mode is a valid config — only the
 * server-side peer table is simulated.
 */
export class MockWireGuardController implements WireGuardController {
  readonly kind = 'mock' as const;
  readonly interfaceName: string;

  private readonly peers = new Map<string, DesiredPeer>();
  private readonly serverKeys: WireGuardKeyPair;

  constructor(interfaceName: string, serverPublicKey?: string) {
    this.interfaceName = interfaceName;
    const generated = MockWireGuardController.curve25519Pair();
    this.serverKeys =
      serverPublicKey && serverPublicKey.length > 0
        ? { privateKey: generated.privateKey, publicKey: serverPublicKey }
        : generated;
    logger.warn('WireGuard mock backend active — no real tunnel is configured', {
      interface: interfaceName,
    });
  }

  /** Raw 32-byte X25519 keys live at the tail of the DER encodings. */
  private static curve25519Pair(): WireGuardKeyPair {
    const { publicKey, privateKey } = generateKeyPairSync('x25519');
    const priv = privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32);
    const pub = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
    return { privateKey: priv.toString('base64'), publicKey: pub.toString('base64') };
  }

  async generateKeyPair(): Promise<WireGuardKeyPair> {
    return MockWireGuardController.curve25519Pair();
  }

  async generatePresharedKey(): Promise<string> {
    return randomBytes(32).toString('base64');
  }

  async addPeer(peer: DesiredPeer): Promise<void> {
    this.peers.set(peer.publicKey, peer);
  }

  async removePeer(publicKey: string): Promise<void> {
    this.peers.delete(publicKey);
  }

  async replacePeer(oldPublicKey: string, peer: DesiredPeer): Promise<void> {
    this.peers.delete(oldPublicKey);
    this.peers.set(peer.publicKey, peer);
  }

  async listPeerPublicKeys(): Promise<string[]> {
    return [...this.peers.keys()];
  }

  async getInterfacePublicKey(): Promise<string | null> {
    return this.serverKeys.publicKey;
  }

  async sync(desired: DesiredPeer[]): Promise<SyncResult> {
    const wanted = new Set(desired.map((p) => p.publicKey));
    let added = 0;
    for (const peer of desired) {
      if (!this.peers.has(peer.publicKey)) added += 1;
      this.peers.set(peer.publicKey, peer);
    }
    let removed = 0;
    for (const key of [...this.peers.keys()]) {
      if (wanted.has(key)) continue;
      this.peers.delete(key);
      removed += 1;
    }
    return { added, removed };
  }
}

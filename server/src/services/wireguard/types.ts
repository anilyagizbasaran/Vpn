export interface WireGuardKeyPair {
  privateKey: string;
  publicKey: string;
}

export interface DesiredPeer {
  publicKey: string;
  /** Addresses routed to this peer on the server side, e.g. `["10.8.0.5/32"]`. */
  allowedIps: string[];
  presharedKey?: string | undefined;
}

export interface SyncResult {
  added: number;
  removed: number;
}

/**
 * Everything the control plane needs from WireGuard. Two implementations:
 * the real `wg` CLI, and an in-process mock for development machines that do
 * not have WireGuard (Windows/macOS dev boxes, CI).
 */
export interface WireGuardController {
  readonly kind: 'cli' | 'mock';
  readonly interfaceName: string;

  generateKeyPair(): Promise<WireGuardKeyPair>;
  generatePresharedKey(): Promise<string>;

  addPeer(peer: DesiredPeer): Promise<void>;
  removePeer(publicKey: string): Promise<void>;

  /**
   * Swaps a peer's key while keeping its address. Must be a single operation:
   * doing it as add-then-remove leaves a window where the device has no
   * working key at all if the second step fails.
   */
  replacePeer(oldPublicKey: string, peer: DesiredPeer): Promise<void>;

  listPeerPublicKeys(): Promise<string[]>;

  /** Null when the interface is not up or the key cannot be read. */
  getInterfacePublicKey(): Promise<string | null>;

  /** Makes the live interface match `desired`, adding and removing as needed. */
  sync(desired: DesiredPeer[]): Promise<SyncResult>;
}

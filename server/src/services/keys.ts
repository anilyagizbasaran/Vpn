import { generateKeyPairSync, randomBytes } from 'node:crypto';

export interface WireGuardKeyPair {
  privateKey: string;
  publicKey: string;
}

/**
 * WireGuard keys without the `wg` binary.
 *
 * The control plane used to shell out to `wg genkey`. It no longer needs to:
 * clients generate their own keys, and node agents apply peers on the nodes.
 * Dropping the dependency is what lets the API run unprivileged, in a
 * container, on a machine with no WireGuard installed at all.
 *
 * Curve25519 keys are 32 raw bytes; Node's X25519 primitives produce them, and
 * the raw scalar sits at the tail of the DER encoding.
 */
export function generateKeyPair(): WireGuardKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  return {
    privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32).toString('base64'),
    publicKey: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64'),
  };
}

/**
 * A preshared key is 32 bytes of randomness and nothing else — `wg genpsk`
 * does exactly this.
 */
export function generatePresharedKey(): string {
  return randomBytes(32).toString('base64');
}

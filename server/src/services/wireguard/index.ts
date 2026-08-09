import { env } from '../../config/env.js';
import { CliWireGuardController } from './cliController.js';
import { MockWireGuardController } from './mockController.js';
import type { WireGuardController } from './types.js';

export type { DesiredPeer, SyncResult, WireGuardController, WireGuardKeyPair } from './types.js';
export { CliWireGuardController } from './cliController.js';
export { MockWireGuardController } from './mockController.js';

export function createWireGuardController(): WireGuardController {
  if (env.WG_MOCK) {
    return new MockWireGuardController(env.WG_INTERFACE, env.WG_SERVER_PUBLIC_KEY);
  }
  return new CliWireGuardController({
    interfaceName: env.WG_INTERFACE,
    useSudo: env.WG_SUDO,
  });
}

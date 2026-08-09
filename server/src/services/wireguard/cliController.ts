import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { logger } from '../../utils/logger.js';
import { run } from '../../utils/exec.js';
import type { CommandRunner } from '../../utils/exec.js';
import { assertWireGuardKey } from '../../utils/validation.js';
import type { DesiredPeer, SyncResult, WireGuardController, WireGuardKeyPair } from './types.js';

export interface CliControllerOptions {
  interfaceName: string;
  /** Prefix interface commands with `sudo -n` (see /etc/sudoers.d/wgapi). */
  useSudo: boolean;
  binary?: string;
  /** Overridable so tests can assert the exact argv without a real `wg`. */
  runner?: CommandRunner;
}

/**
 * Drives the `wg` CLI. Commands are spawned with an argv array and never a
 * shell, and every key is format-checked before it reaches argv.
 */
export class CliWireGuardController implements WireGuardController {
  readonly kind = 'cli' as const;
  readonly interfaceName: string;

  private readonly useSudo: boolean;
  private readonly binary: string;
  private readonly run: CommandRunner;

  constructor(options: CliControllerOptions) {
    this.interfaceName = options.interfaceName;
    this.useSudo = options.useSudo;
    this.binary = options.binary ?? 'wg';
    this.run = options.runner ?? run;
  }

  /** Key generation is unprivileged — do not burn a sudo call on it. */
  private wgPlain(args: string[], input?: string) {
    return input === undefined
      ? this.run(this.binary, args)
      : this.run(this.binary, args, { input });
  }

  /** Reading or mutating the interface needs root. */
  private wgPrivileged(args: string[]) {
    return this.useSudo
      ? this.run('sudo', ['-n', this.binary, ...args])
      : this.run(this.binary, args);
  }

  async generateKeyPair(): Promise<WireGuardKeyPair> {
    const privateKey = (await this.wgPlain(['genkey'])).stdout.trim();
    const publicKey = (await this.wgPlain(['pubkey'], privateKey)).stdout.trim();
    assertWireGuardKey(privateKey, 'generated private key');
    assertWireGuardKey(publicKey, 'derived public key');
    return { privateKey, publicKey };
  }

  async generatePresharedKey(): Promise<string> {
    const psk = (await this.wgPlain(['genpsk'])).stdout.trim();
    assertWireGuardKey(psk, 'generated preshared key');
    return psk;
  }

  async addPeer(peer: DesiredPeer): Promise<void> {
    assertWireGuardKey(peer.publicKey, 'peer public key');

    const args = [
      'set',
      this.interfaceName,
      'peer',
      peer.publicKey,
      'allowed-ips',
      peer.allowedIps.join(','),
    ];

    if (peer.presharedKey === undefined) {
      await this.wgPrivileged(args);
      return;
    }

    assertWireGuardKey(peer.presharedKey, 'preshared key');
    // `wg set` only reads a preshared key from a file, so write one that only
    // this process can read and delete it as soon as the command returns.
    const dir = await mkdtemp(join(tmpdir(), 'wgpsk-'));
    const pskPath = join(dir, 'psk');
    try {
      await writeFile(pskPath, `${peer.presharedKey}\n`, { mode: 0o600 });
      await this.wgPrivileged([...args, 'preshared-key', pskPath]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  async removePeer(publicKey: string): Promise<void> {
    assertWireGuardKey(publicKey, 'peer public key');
    await this.wgPrivileged(['set', this.interfaceName, 'peer', publicKey, 'remove']);
  }

  /**
   * One `wg set` carrying both peer blocks. WireGuard treats allowed-ips as
   * exclusive, so assigning the address to the new key removes it from the old
   * one in the same operation — there is no moment where both keys can route,
   * and no moment where neither can.
   */
  async replacePeer(oldPublicKey: string, peer: DesiredPeer): Promise<void> {
    assertWireGuardKey(oldPublicKey, 'previous peer public key');
    assertWireGuardKey(peer.publicKey, 'new peer public key');

    const args = [
      'set',
      this.interfaceName,
      'peer',
      peer.publicKey,
      'allowed-ips',
      peer.allowedIps.join(','),
    ];

    let dir: string | null = null;
    try {
      if (peer.presharedKey !== undefined) {
        assertWireGuardKey(peer.presharedKey, 'preshared key');
        dir = await mkdtemp(join(tmpdir(), 'wgpsk-'));
        const pskPath = join(dir, 'psk');
        await writeFile(pskPath, `${peer.presharedKey}\n`, { mode: 0o600 });
        args.push('preshared-key', pskPath);
      }
      args.push('peer', oldPublicKey, 'remove');
      await this.wgPrivileged(args);
    } finally {
      if (dir) await rm(dir, { recursive: true, force: true });
    }
  }

  async listPeerPublicKeys(): Promise<string[]> {
    const { stdout } = await this.wgPrivileged(['show', this.interfaceName, 'peers']);
    return stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }

  async getInterfacePublicKey(): Promise<string | null> {
    try {
      const { stdout } = await this.wgPrivileged(['show', this.interfaceName, 'public-key']);
      const key = stdout.trim();
      return key.length > 0 ? key : null;
    } catch (error) {
      logger.warn('could not read interface public key', {
        interface: this.interfaceName,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Reconciles the whole interface in a single `wg set` call.
   *
   * `wg set` accepts any number of `peer` blocks, and a block may be either an
   * upsert or `... remove`. Doing it one peer at a time meant one sudo+spawn
   * per peer — 250 processes at boot on a server with 250 devices.
   *
   * Deliberately not `wg setconf`/`syncconf`: those replace the interface
   * section too, and this config file has no [Interface] block of its own to
   * give them.
   */
  async sync(desired: DesiredPeer[]): Promise<SyncResult> {
    const live = new Set(await this.listPeerPublicKeys());
    const wanted = new Set(desired.map((p) => p.publicKey));

    const args = ['set', this.interfaceName];
    let added = 0;
    let removed = 0;

    // One temp dir for every preshared key in this batch; `wg set` only reads
    // them from files, and they are gone before the function returns.
    let pskDir: string | null = null;
    try {
      for (const [index, peer] of desired.entries()) {
        assertWireGuardKey(peer.publicKey, 'peer public key');
        // Re-applying a peer that is already there is free and repairs drifted
        // allowed-ips, so the whole desired set goes in unconditionally.
        args.push('peer', peer.publicKey, 'allowed-ips', peer.allowedIps.join(','));

        if (peer.presharedKey !== undefined) {
          assertWireGuardKey(peer.presharedKey, 'preshared key');
          pskDir ??= await mkdtemp(join(tmpdir(), 'wgpsk-'));
          // Indexed, not keyed by public key: base64 contains '/'.
          const pskPath = join(pskDir, `peer-${index}.psk`);
          await writeFile(pskPath, `${peer.presharedKey}\n`, { mode: 0o600 });
          args.push('preshared-key', pskPath);
        }

        if (!live.has(peer.publicKey)) added += 1;
      }

      for (const publicKey of live) {
        if (wanted.has(publicKey)) continue;
        assertWireGuardKey(publicKey, 'live peer public key');
        args.push('peer', publicKey, 'remove');
        removed += 1;
      }

      // Nothing to reconcile — skip the subprocess entirely.
      if (args.length > 2) await this.wgPrivileged(args);
    } finally {
      if (pskDir) await rm(pskDir, { recursive: true, force: true });
    }

    return { added, removed };
  }
}

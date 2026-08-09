import { readFile } from 'node:fs/promises';
import { beforeEach, describe, expect, it } from 'vitest';
import { CliWireGuardController } from '../src/services/wireguard/cliController.js';
import type { CommandRunner, RunResult } from '../src/utils/exec.js';

/**
 * These cover the code path that actually runs in production. The `wg` binary
 * is replaced by a recorder, so the assertions are about the exact argv that
 * would reach it — which is where a mistake would either corrupt the interface
 * or leak a key onto a command line.
 */

interface Invocation {
  file: string;
  args: string[];
  input: string | undefined;
  /** Contents of any file passed after `preshared-key`, read before cleanup. */
  pskFiles: string[];
}

const VALID_KEY_A = 'aGVsbG93b3JsZGhlbGxvd29ybGRoZWxsb3dvcmxkMTI=';
const VALID_KEY_B = 'Ynl0ZXNieXRlc2J5dGVzYnl0ZXNieXRlc2J5dGVzMTI=';
const VALID_PSK = 'cHNrcHNrcHNrcHNrcHNrcHNrcHNrcHNrcHNrcHNrcHM=';

let calls: Invocation[];
let responses: Map<string, string>;

/** Keys the fake `wg genkey` hands out, in order. */
const generated = [VALID_KEY_A, VALID_KEY_B];

function makeRunner(): CommandRunner {
  return async (file, args, options): Promise<RunResult> => {
    // Read any preshared-key file while it still exists; the controller
    // deletes it as soon as the command returns.
    const pskFiles: string[] = [];
    for (let i = 0; i < args.length - 1; i += 1) {
      if (args[i] === 'preshared-key') {
        pskFiles.push((await readFile(args[i + 1] as string, 'utf8')).trim());
      }
    }

    calls.push({ file, args, input: options?.input, pskFiles });

    const wgArgs = file === 'sudo' ? args.slice(2) : args;
    const key = wgArgs.join(' ');
    for (const [pattern, stdout] of responses) {
      if (key.startsWith(pattern)) return { stdout, stderr: '' };
    }
    return { stdout: '', stderr: '' };
  };
}

function controller(useSudo = false) {
  return new CliWireGuardController({
    interfaceName: 'wg0',
    useSudo,
    runner: makeRunner(),
  });
}

beforeEach(() => {
  calls = [];
  responses = new Map([
    ['genkey', `${VALID_KEY_A}\n`],
    ['pubkey', `${VALID_KEY_B}\n`],
    ['genpsk', `${VALID_PSK}\n`],
    ['show wg0 peers', ''],
    ['show wg0 public-key', `${VALID_KEY_A}\n`],
  ]);
});

describe('key generation', () => {
  it('derives the public key by piping the private key to `wg pubkey`', async () => {
    const wg = controller();
    const pair = await wg.generateKeyPair();

    expect(pair).toEqual({ privateKey: VALID_KEY_A, publicKey: VALID_KEY_B });
    expect(calls.map((c) => c.args)).toEqual([['genkey'], ['pubkey']]);
    // The private key goes over stdin, never as an argument — argv is visible
    // to every other process on the box via /proc.
    expect(calls[1]?.input).toBe(VALID_KEY_A);
    expect(calls[1]?.args).not.toContain(VALID_KEY_A);
  });

  it('never uses sudo for key generation', async () => {
    const wg = controller(true);
    await wg.generateKeyPair();
    await wg.generatePresharedKey();

    expect(calls.every((c) => c.file === 'wg')).toBe(true);
  });

  it('rejects a malformed key coming back from the binary', async () => {
    responses.set('genkey', 'not-a-wireguard-key\n');
    await expect(controller().generateKeyPair()).rejects.toThrow(/not a valid WireGuard key/);
  });
});

describe('privilege handling', () => {
  it('prefixes interface commands with `sudo -n` when configured', async () => {
    const wg = controller(true);
    await wg.addPeer({ publicKey: VALID_KEY_A, allowedIps: ['10.8.0.2/32'] });

    expect(calls[0]?.file).toBe('sudo');
    // -n: never prompt. A password prompt would hang the request instead.
    expect(calls[0]?.args.slice(0, 3)).toEqual(['-n', 'wg', 'set']);
  });

  it('calls `wg` directly when sudo is off', async () => {
    const wg = controller(false);
    await wg.addPeer({ publicKey: VALID_KEY_A, allowedIps: ['10.8.0.2/32'] });

    expect(calls[0]?.file).toBe('wg');
    expect(calls[0]?.args[0]).toBe('set');
  });
});

describe('addPeer', () => {
  it('builds the expected argv', async () => {
    await controller().addPeer({
      publicKey: VALID_KEY_A,
      allowedIps: ['10.8.0.2/32', '10.8.0.3/32'],
    });

    expect(calls[0]?.args).toEqual([
      'set',
      'wg0',
      'peer',
      VALID_KEY_A,
      'allowed-ips',
      '10.8.0.2/32,10.8.0.3/32',
    ]);
  });

  it('passes a preshared key by file, not on the command line', async () => {
    await controller().addPeer({
      publicKey: VALID_KEY_A,
      allowedIps: ['10.8.0.2/32'],
      presharedKey: VALID_PSK,
    });

    const call = calls[0];
    expect(call?.args).toContain('preshared-key');
    expect(call?.args.join(' ')).not.toContain(VALID_PSK);
    expect(call?.pskFiles).toEqual([VALID_PSK]);
  });

  it('rejects a public key that is not a WireGuard key', async () => {
    await expect(
      controller().addPeer({ publicKey: 'rm -rf /', allowedIps: ['10.8.0.2/32'] }),
    ).rejects.toThrow(/not a valid WireGuard key/);
    expect(calls).toHaveLength(0);
  });

  it('rejects a malformed preshared key before spawning anything', async () => {
    await expect(
      controller().addPeer({
        publicKey: VALID_KEY_A,
        allowedIps: ['10.8.0.2/32'],
        presharedKey: 'short',
      }),
    ).rejects.toThrow(/not a valid WireGuard key/);
    expect(calls).toHaveLength(0);
  });
});

describe('removePeer and listPeerPublicKeys', () => {
  it('removes by key', async () => {
    await controller().removePeer(VALID_KEY_A);
    expect(calls[0]?.args).toEqual(['set', 'wg0', 'peer', VALID_KEY_A, 'remove']);
  });

  it('parses the peer list, ignoring blank lines', async () => {
    responses.set('show wg0 peers', `${VALID_KEY_A}\n\n  ${VALID_KEY_B}  \n\n`);
    await expect(controller().listPeerPublicKeys()).resolves.toEqual([VALID_KEY_A, VALID_KEY_B]);
  });

  it('reports a null interface key instead of throwing when the interface is down', async () => {
    const wg = new CliWireGuardController({
      interfaceName: 'wg0',
      useSudo: false,
      runner: async () => {
        throw new Error('Unable to access interface: No such device');
      },
    });

    await expect(wg.getInterfacePublicKey()).resolves.toBeNull();
  });
});

describe('sync', () => {
  it('reconciles the whole interface in a single `wg set` call', async () => {
    responses.set('show wg0 peers', `${VALID_KEY_B}\n`);

    const wg = controller();
    const result = await wg.sync([{ publicKey: VALID_KEY_A, allowedIps: ['10.8.0.2/32'] }]);

    // One read of the live peer list, then exactly one mutation.
    expect(calls).toHaveLength(2);
    expect(calls[0]?.args).toEqual(['show', 'wg0', 'peers']);
    expect(calls[1]?.args).toEqual([
      'set',
      'wg0',
      'peer',
      VALID_KEY_A,
      'allowed-ips',
      '10.8.0.2/32',
      'peer',
      VALID_KEY_B,
      'remove',
    ]);
    expect(result).toEqual({ added: 1, removed: 1 });
  });

  it('batches many peers into one invocation', async () => {
    const peers = Array.from({ length: 50 }, (_, i) => ({
      publicKey: i % 2 === 0 ? VALID_KEY_A : VALID_KEY_B,
      allowedIps: [`10.8.0.${i + 2}/32`],
    }));

    await controller().sync(peers);

    // The point of the batch: not 50 subprocesses.
    expect(calls).toHaveLength(2);
    expect(calls[1]?.args.filter((a) => a === 'peer')).toHaveLength(50);
  });

  it('writes one preshared-key file per peer that has one', async () => {
    const result = await controller().sync([
      { publicKey: VALID_KEY_A, allowedIps: ['10.8.0.2/32'], presharedKey: VALID_PSK },
      { publicKey: VALID_KEY_B, allowedIps: ['10.8.0.3/32'], presharedKey: VALID_PSK },
    ]);

    expect(calls[1]?.pskFiles).toEqual([VALID_PSK, VALID_PSK]);
    // Distinct paths — a shared filename would make the second peer overwrite
    // the first before `wg` ever read it.
    const paths = (calls[1]?.args ?? []).filter((_, i, a) => a[i - 1] === 'preshared-key');
    expect(new Set(paths).size).toBe(2);
    expect(result.added).toBe(2);
  });

  it('re-applies peers that are already present, repairing drifted allowed-ips', async () => {
    responses.set('show wg0 peers', `${VALID_KEY_A}\n`);

    const result = await controller().sync([
      { publicKey: VALID_KEY_A, allowedIps: ['10.8.0.9/32'] },
    ]);

    expect(calls[1]?.args).toContain('10.8.0.9/32');
    expect(result).toEqual({ added: 0, removed: 0 });
  });

  it('skips the subprocess entirely when there is nothing to do', async () => {
    const result = await controller().sync([]);

    expect(calls).toHaveLength(1); // only the peer listing
    expect(result).toEqual({ added: 0, removed: 0 });
  });

  it('wipes every peer when the desired set is empty but the interface is not', async () => {
    responses.set('show wg0 peers', `${VALID_KEY_A}\n${VALID_KEY_B}\n`);

    const result = await controller().sync([]);

    expect(calls[1]?.args).toEqual([
      'set',
      'wg0',
      'peer',
      VALID_KEY_A,
      'remove',
      'peer',
      VALID_KEY_B,
      'remove',
    ]);
    expect(result).toEqual({ added: 0, removed: 2 });
  });

  it('propagates a failure instead of silently reporting success', async () => {
    const wg = new CliWireGuardController({
      interfaceName: 'wg0',
      useSudo: false,
      runner: async (_file, args) => {
        if (args.includes('peers')) return { stdout: '', stderr: '' };
        throw new Error('sudo: a password is required');
      },
    });

    await expect(
      wg.sync([{ publicKey: VALID_KEY_A, allowedIps: ['10.8.0.2/32'] }]),
    ).rejects.toThrow(/password is required/);
  });
});

describe('generated key sanity', () => {
  it('only accepts 32-byte base64 keys', () => {
    for (const key of generated) {
      expect(Buffer.from(key, 'base64')).toHaveLength(32);
    }
  });
});

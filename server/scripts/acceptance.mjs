#!/usr/bin/env node
/**
 * End-to-end acceptance test against a *running* control plane.
 *
 * The unit suite proves the code is right against a mock WireGuard. This
 * proves the deployment is right: TLS, the reverse proxy, the real `wg`
 * binary, sudo or capabilities, the database file, the address pool. Those are
 * the things that are fine on a laptop and broken on a VPS.
 *
 * It creates its own accounts and deletes them at the end, so it is safe to
 * run against production — though it does consume peer addresses while it
 * runs.
 *
 *   node scripts/acceptance.mjs https://api.example.com
 *   node scripts/acceptance.mjs https://api.example.com --check-wg
 *
 * --check-wg     also watch `wg show` locally, proving the node agent applies
 *                what the API hands out. Only valid on a machine that is both
 *                the control plane and a VPN node.
 * --rate-limits  exercise the auth rate limiter (locks this IP out for 15 min)
 */

import { generateKeyPairSync } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const baseUrl = (process.argv[2] ?? '').replace(/\/+$/, '');
const flags = new Set(process.argv.slice(3));

if (!baseUrl) {
  console.error('usage: node scripts/acceptance.mjs <base-url> [--check-wg] [--rate-limits]');
  process.exit(2);
}

// --- tiny harness ----------------------------------------------------------

const results = { passed: 0, failed: 0, skipped: 0 };
const failures = [];
let currentGroup = '';

const c = {
  dim: (s) => `\x1b[90m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

function group(name) {
  currentGroup = name;
  console.log(`\n${c.bold(name)}`);
}

async function check(description, fn) {
  try {
    await fn();
    results.passed += 1;
    console.log(`  ${c.green('PASS')} ${description}`);
  } catch (error) {
    results.failed += 1;
    failures.push({ group: currentGroup, description, message: error.message });
    console.log(`  ${c.red('FAIL')} ${description}`);
    console.log(`       ${c.red(error.message)}`);
  }
}

function skip(description, why) {
  results.skipped += 1;
  console.log(`  ${c.yellow('SKIP')} ${description} ${c.dim(`(${why})`)}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertEqual(actual, expected, what) {
  if (actual !== expected) {
    throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// --- HTTP ------------------------------------------------------------------

async function call(method, path, { token, body, expect } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      accept: 'application/json',
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // Left null; the caller's status assertion will report the real problem.
  }

  if (expect !== undefined && response.status !== expect) {
    throw new Error(
      `${method} ${path}: expected ${expect}, got ${response.status} — ${text.slice(0, 300)}`,
    );
  }

  return { status: response.status, headers: response.headers, body: json, text };
}

/** A keypair generated the way the apps do: only the public half is sent. */
function clientKeypair() {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  return {
    publicKey: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64'),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32).toString('base64'),
  };
}

function wgPeers() {
  const output = execFileSync('sudo', ['-n', 'wg', 'show', 'wg0', 'peers'], { encoding: 'utf8' });
  return output.split('\n').map((line) => line.trim()).filter(Boolean);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Waits for the node agent to apply (or remove) a key.
 *
 * The control plane no longer touches the interface: it answers, and the agent
 * pulls. So a device is not on the interface the instant the API returns —
 * it lands within one poll interval. Waiting here is the point rather than a
 * workaround: it exercises the whole chain, which is exactly what a mock can
 * never catch.
 */
async function waitForPeer(publicKey, { present, timeoutMs = 45_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = [];

  while (Date.now() < deadline) {
    last = wgPeers();
    if (last.includes(publicKey) === present) return;
    await sleep(2_000);
  }

  throw new Error(
    present
      ? `the key never reached the interface within ${timeoutMs / 1000}s — is vpn-node-agent running?`
      : `the key was still on the interface after ${timeoutMs / 1000}s — the agent is not removing peers`,
  );
}

const stamp = Date.now();
const password = `acceptance-${stamp}-password`;
const accounts = [];

async function register(suffix) {
  const email = `acceptance+${stamp}-${suffix}@example.invalid`;
  const { body } = await call('POST', '/auth/register', {
    body: { email, password },
    expect: 201,
  });
  const account = { email, ...body.tokens, userId: body.user.id };
  accounts.push(account);
  return account;
}

// --- the tests -------------------------------------------------------------

async function main() {
  console.log(c.bold(`\nAcceptance run against ${baseUrl}`));
  console.log(c.dim(`test accounts are prefixed acceptance+${stamp} and deleted at the end`));

  let ready;

  group('Deployment');

  await check('/health answers', async () => {
    const { body } = await call('GET', '/health', { expect: 200 });
    assertEqual(body.status, 'ok', 'status');
  });

  await check('/ready reports at least one live node', async () => {
    const response = await call('GET', '/ready');
    ready = response.body;
    assertEqual(
      response.status,
      200,
      'status (503 means no node agent has synced — is vpn-node-agent running?)',
    );
    assert(ready.nodes?.length > 0, '/ready lists no nodes — define one with `npm run node:add`');
  });

  await check('every node has an agent token', async () => {
    const missing = ready.nodes.filter((node) => !node.agentProvisioned);
    assert(
      missing.length === 0,
      `no agent token for: ${missing.map((n) => n.region).join(', ')} — its peers exist in the database and nowhere else`,
    );
  });

  await check('every active node is reporting', async () => {
    const quiet = ready.nodes.filter((node) => node.status === 'active' && !node.online);
    assert(
      quiet.length === 0,
      `no recent sync from: ${quiet.map((n) => n.region).join(', ')} — the agent is stopped or cannot reach this API`,
    );
  });

  await check('each node reports the interface key the database expects', async () => {
    // A node rebuilt with a new key hands every client in that region a config
    // that can never handshake, and nothing else reports it.
    const mismatched = ready.nodes.filter((node) => node.keyMatchesConfig === false);
    assert(
      mismatched.length === 0,
      `key mismatch on: ${mismatched.map((n) => n.region).join(', ')} — update it with \`npm run node:add\``,
    );
  });

  if (baseUrl.startsWith('https://')) {
    await check('HSTS is set by the reverse proxy', async () => {
      const { headers } = await call('GET', '/health');
      assert(headers.get('strict-transport-security'), 'no Strict-Transport-Security header');
    });

    await check('the server banner is suppressed', async () => {
      const { headers } = await call('GET', '/health');
      assert(!headers.get('x-powered-by'), 'x-powered-by is present');
    });
  } else {
    skip('TLS headers', 'not an https:// URL');
  }

  await check('unknown routes return a structured 404', async () => {
    const { body } = await call('GET', '/definitely-not-a-route', { expect: 404 });
    assertEqual(body?.error?.code, 'not_found', 'error.code');
  });

  group('Authentication');

  const alice = await register('alice');

  await check('registration returned a usable session', async () => {
    assert(alice.accessToken && alice.refreshToken, 'tokens missing');
    const { body } = await call('GET', '/auth/me', { token: alice.accessToken, expect: 200 });
    assertEqual(body.user.email, alice.email, 'email');
  });

  await check('a wrong password is rejected', async () => {
    await call('POST', '/auth/login', {
      body: { email: alice.email, password: `${password}-wrong` },
      expect: 401,
    });
  });

  await check('refresh rotates the token', async () => {
    const { body } = await call('POST', '/auth/refresh', {
      body: { refreshToken: alice.refreshToken },
      expect: 200,
    });
    assert(body.tokens.refreshToken !== alice.refreshToken, 'the refresh token was not rotated');
    alice.previousRefreshToken = alice.refreshToken;
    alice.accessToken = body.tokens.accessToken;
    alice.refreshToken = body.tokens.refreshToken;
  });

  await check('replaying a consumed refresh token kills the session family', async () => {
    // The leak signal. If this passes silently the whole rotation scheme is
    // decorative.
    await call('POST', '/auth/refresh', {
      body: { refreshToken: alice.previousRefreshToken },
      expect: 401,
    });
    await call('POST', '/auth/refresh', {
      body: { refreshToken: alice.refreshToken },
      expect: 401,
    });

    // Recover a working session for the rest of the run.
    const { body } = await call('POST', '/auth/login', {
      body: { email: alice.email, password },
      expect: 200,
    });
    alice.accessToken = body.tokens.accessToken;
    alice.refreshToken = body.tokens.refreshToken;
  });

  await check('an unauthenticated request is refused', async () => {
    await call('GET', '/devices', { expect: 401 });
  });

  group('Devices');

  const keys = clientKeypair();
  let device;

  await check('a device registers with a client-generated key', async () => {
    const { body } = await call('POST', '/devices', {
      token: alice.accessToken,
      body: { label: 'Acceptance device', publicKey: keys.publicKey, platform: 'linux' },
      expect: 201,
    });
    device = body.device;
    assertEqual(body.device.publicKey, keys.publicKey, 'publicKey');
    assertEqual(body.device.platform, 'linux', 'platform');
  });

  await check('the server returned no private key', async () => {
    // The single most important property of the whole design.
    const { body } = await call('GET', `/devices/${device.id}/config`, {
      token: alice.accessToken,
      expect: 200,
    });
    assertEqual(body.privateKey, null, 'privateKey');
    assertEqual(body.privateKeyIncluded, false, 'privateKeyIncluded');
    assert(body.conf.includes('<PRIVATE_KEY>'), 'the config has no placeholder');
    assert(!body.conf.includes(keys.privateKey), 'the config leaked the private key');
  });

  await check('the config is complete enough to hand to wg-quick', async () => {
    const { body } = await call('GET', `/devices/${device.id}/config`, { token: alice.accessToken });
    for (const key of ['[Interface]', 'Address =', '[Peer]', 'PublicKey =', 'AllowedIPs =', 'Endpoint =']) {
      assert(body.conf.includes(key), `the config is missing ${key}`);
    }
    assert(!body.conf.includes('\r'), 'the config has CRLF line endings; some parsers reject them');
    assert(
      /Endpoint = [^\s:]+:\d+/.test(body.conf),
      'Endpoint is not host:port — WG_ENDPOINT is probably wrong',
    );
  });

  if (flags.has('--check-wg')) {
    await check('the device reaches the interface', async () => {
      // Not instant any more: the agent pulls it within one poll interval.
      await waitForPeer(device.publicKey, { present: true });
    });
  } else {
    skip('the device reaches the interface', 'pass --check-wg on a node');
  }

  await check('the address came from the configured pool', async () => {
    // /ready answers with `nodes`, not `server` — the old field name survived
    // the split of devices from peers and quietly failed this check.
    const location = device.locations[0];
    assert(
      /^\d+\.\d+\.\d+\.\d+\/32$/.test(location.allowedIp),
      `allowedIp looks wrong: ${location.allowedIp}`,
    );
    // A location with no endpoint renders a config that can never hand shake,
    // and nothing downstream would say why.
    assert(location.endpoint, `no endpoint reported for region ${location.region}`);
  });

  await check('rotating keeps the device identity and drops the old key', async () => {
    const rotated = clientKeypair();
    const { body } = await call('POST', `/devices/${device.id}/rotate`, {
      token: alice.accessToken,
      body: { publicKey: rotated.publicKey },
      expect: 200,
    });

    assertEqual(body.device.id, device.id, 'device id changed');
    assertEqual(
      body.device.locations[0].allowedIp,
      device.locations[0].allowedIp,
      'address changed',
    );
    assertEqual(body.device.publicKey, rotated.publicKey, 'publicKey');
    assert(body.device.keyRotatedAt, 'keyRotatedAt was not set');

    if (flags.has('--check-wg')) {
      await waitForPeer(rotated.publicKey, { present: true });
      // The whole point of rotation: a leaked config expires by itself.
      await waitForPeer(keys.publicKey, { present: false });
    }
    device.publicKey = rotated.publicKey;
  });

  await check('rotation did not consume a device slot', async () => {
    const { body } = await call('GET', '/devices', { token: alice.accessToken, expect: 200 });
    assertEqual(body.devices.length, 1, 'device count');
  });

  await check('a malformed public key is rejected', async () => {
    await call('POST', '/devices', {
      token: alice.accessToken,
      body: { publicKey: 'not-a-key' },
      expect: 400,
    });
  });

  group('Isolation and limits');

  const mallory = await register('mallory');

  await check("another account cannot read Alice's config", async () => {
    await call('GET', `/devices/${device.id}/config`, { token: mallory.accessToken, expect: 404 });
  });

  await check("another account cannot revoke Alice's device", async () => {
    await call('DELETE', `/devices/${device.id}`, { token: mallory.accessToken, expect: 404 });
  });

  await check("another account cannot rotate Alice's key", async () => {
    await call('POST', `/devices/${device.id}/rotate`, {
      token: mallory.accessToken,
      body: { publicKey: clientKeypair().publicKey },
      expect: 404,
    });
  });

  await check('the device limit is enforced', async () => {
    let created = 1; // Alice already has one.
    let limit = null;

    for (let i = 0; i < 20; i += 1) {
      const response = await call('POST', '/devices', {
        token: alice.accessToken,
        body: { publicKey: clientKeypair().publicKey, deviceLabel: `filler-${i}` },
      });
      if (response.status === 201) {
        created += 1;
        continue;
      }
      assertEqual(response.status, 409, 'status once the limit is reached');
      assertEqual(response.body?.error?.code, 'peer_quota_exceeded', 'error.code');
      limit = response.body?.error?.details?.limit ?? created;
      break;
    }

    assert(limit !== null, `the limit was never reached after ${created} devices — MAX_DEVICES_PER_USER may be unset`);
    assertEqual(created, limit, 'devices created before the limit fired');
  });

  await check('revoking frees a slot', async () => {
    const { body: before } = await call('GET', '/devices', { token: alice.accessToken });
    await call('DELETE', `/devices/${before.devices[0].id}`, {
      token: alice.accessToken,
      expect: 204,
    });

    const { body: after } = await call('GET', '/devices', { token: alice.accessToken });
    assertEqual(after.devices.length, before.devices.length - 1, 'device count after revoke');

    await call('POST', '/devices', {
      token: alice.accessToken,
      body: { publicKey: clientKeypair().publicKey },
      expect: 201,
    });
  });

  group('Input handling');

  await check('malformed JSON returns 400, not 500', async () => {
    const response = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"email": "a@b.co", ',
    });
    assertEqual(response.status, 400, 'status');
  });

  await check('an oversized body returns 413, not 500', async () => {
    const response = await fetch(`${baseUrl}/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'big@example.invalid', password: 'x'.repeat(200_000) }),
    });
    assert(
      response.status === 413 || response.status === 400,
      `expected 413, got ${response.status} — a 500 means the error handler is not catching body-parser errors`,
    );
  });

  await check('a device label with control characters is rejected', async () => {
    await call('POST', '/devices', {
      token: alice.accessToken,
      // `label`, not `deviceLabel` — the wrong field name meant the server saw
      // no label at all, happily created the device, and this check passed
      // without ever exercising the thing it exists to prove.
      body: { label: 'evil\nAllowedIPs = 10.0.0.0/8', publicKey: clientKeypair().publicKey },
      expect: 400,
    });
  });

  if (flags.has('--rate-limits')) {
    group('Rate limiting');
    await check('repeated bad logins are throttled', async () => {
      let throttled = false;
      for (let i = 0; i < 15; i += 1) {
        const response = await call('POST', '/auth/login', {
          body: { email: `nobody-${i}@example.invalid`, password: 'wrong-password-here' },
        });
        if (response.status === 429) {
          throttled = true;
          break;
        }
      }
      assert(throttled, 'no 429 after 15 attempts — the limiter is off or TRUST_PROXY is wrong');
    });
  } else {
    skip('rate limiting', 'pass --rate-limits; it locks this IP out for 15 minutes');
  }

  group('Cleanup');

  for (const account of accounts) {
    await check(`account ${account.email.split('+')[1]} deletes itself`, async () => {
      // Also the erasure path: peers and refresh tokens go with the user.
      const login = await call('POST', '/auth/login', {
        body: { email: account.email, password },
        expect: 200,
      });
      await call('DELETE', '/auth/account', {
        token: login.body.tokens.accessToken,
        body: { password },
        expect: 204,
      });
      await call('POST', '/auth/login', {
        body: { email: account.email, password },
        expect: 401,
      });
    });
  }

  if (flags.has('--check-wg')) {
    await check('the agent removed the deleted account from the interface', async () => {
      await waitForPeer(device.publicKey, { present: false });
    });
  }
}

// --- run -------------------------------------------------------------------

try {
  await main();
} catch (error) {
  console.log(`\n${c.red('The run stopped early:')} ${error.message}`);
  results.failed += 1;
  failures.push({ group: currentGroup, description: 'run aborted', message: error.message });
}

console.log(`\n${c.bold('Summary')}`);
console.log(`  ${c.green(`${results.passed} passed`)}  ${
  results.failed ? c.red(`${results.failed} failed`) : '0 failed'
}  ${c.dim(`${results.skipped} skipped`)}`);

if (failures.length > 0) {
  console.log(`\n${c.bold('Failures')}`);
  for (const failure of failures) {
    console.log(`  ${c.red('×')} ${c.dim(`${failure.group} ›`)} ${failure.description}`);
    console.log(`    ${failure.message}`);
  }
  console.log(
    `\n${c.yellow('Test accounts may be left behind. They are prefixed')} acceptance+${stamp}`,
  );
}

process.exit(results.failed > 0 ? 1 : 0);

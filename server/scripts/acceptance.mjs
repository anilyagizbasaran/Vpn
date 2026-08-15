#!/usr/bin/env node
/**
 * End-to-end acceptance test against a *running* control plane.
 *
 * The unit suite proves the code is right against a mock WireGuard. This
 * proves the deployment is right: TLS, the reverse proxy, the real `wg`
 * binary, sudo or capabilities, the database file, the address pool. Those are
 * the things that are fine on a laptop and broken on a VPS.
 *
 * It needs an invite code, because that is now the only way in. Mint a
 * one with `vpn status`. Every device the run enrols removes itself at the
 * end, so it is safe against production, though it does consume peer
 * addresses while it runs.
 *
 *   node scripts/acceptance.mjs https://api.example.com AB12CD34EF
 *   node scripts/acceptance.mjs https://api.example.com AB12CD34EF --check-wg
 *
 * --check-wg     also watch `wg show` locally, proving the node agent applies
 *                what the API hands out. Only valid on a machine that is both
 *                the control plane and a VPN node.
 * --rate-limits  exercise the enrolment rate limiter (locks this IP out)
 */

import { generateKeyPairSync } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const baseUrl = (process.argv[2] ?? '').replace(/\/+$/, '');
const inviteToken = process.argv[3] ?? '';
const flags = new Set(process.argv.slice(4));

if (!baseUrl || inviteToken.length < 8) {
  console.error(
    'usage: node scripts/acceptance.mjs <base-url> <invite-code> [--check-wg] [--rate-limits]',
  );
  console.error('see the code with: vpn status  (or vpn reset for a fresh one)');
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

/** Every device this run creates, so cleanup can remove all of them. */
const enrolled = [];

/**
 * Enrols one device the way an app does: generate the pair here, send only the
 * public half, keep the token that comes back.
 */
async function enrol(_label, { expect = 201 } = {}) {
  const keys = clientKeypair();
  const response = await call('POST', '/enroll', {
    body: { inviteToken, publicKey: keys.publicKey },
    expect,
  });
  const device = {
    ...keys,
    token: response.body.deviceToken,
    id: response.body.device.id,
    locations: response.body.device.locations,
    body: response.body,
  };
  enrolled.push(device);
  return device;
}

// --- the tests -------------------------------------------------------------

async function main() {
  console.log(c.bold(`\nAcceptance run against ${baseUrl}`));
  console.log(c.dim('every device this run enrols removes itself at the end'));

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

  group('Enrolment');

  await check('an unauthenticated request is refused', async () => {
    await call('GET', '/device', { expect: 401 });
  });

  await check('a wrong invite code is refused', async () => {
    await call('POST', '/enroll', {
      body: { inviteToken: 'ZZZZZZZZZZ', publicKey: clientKeypair().publicKey },
      expect: 401,
    });
  });

  const device = await enrol('Acceptance device');

  await check('enrolment returned a device token and a config', async () => {
    assert(device.token?.startsWith('vpndev_'), `deviceToken looks wrong: ${device.token}`);
    assertEqual(device.body.device.publicKey, device.publicKey, 'publicKey');
  });

  await check('the device token authenticates as exactly that device', async () => {
    const { body } = await call('GET', '/device', { token: device.token, expect: 200 });
    assertEqual(body.device.id, device.id, 'device id');
  });

  await check('the invite cannot be spent as a device token', async () => {
    // Both are opaque strings the same client holds. Only the domain separator
    // in the hash keeps one from being presented as the other, and an invite
    // that authenticated as a device would be a device that could enrol more.
    await call('GET', '/device', { token: inviteToken, expect: 401 });
  });

  await check('a device token cannot be spent as an invite', async () => {
    await call('POST', '/enroll', {
      body: { inviteToken: device.token, publicKey: clientKeypair().publicKey },
      expect: 401,
    });
  });

  group('Devices');

  await check('the server returned no private key', async () => {
    // The single most important property of the whole design.
    const { body } = await call('GET', '/device/config', {
      token: device.token,
      expect: 200,
    });
    assertEqual(body.privateKey, null, 'privateKey');
    assertEqual(body.privateKeyIncluded, false, 'privateKeyIncluded');
    assert(body.conf.includes('<PRIVATE_KEY>'), 'the config has no placeholder');
    assert(!body.conf.includes(device.privateKey), 'the config leaked the private key');
  });

  await check('a config is never cached anywhere on the path', async () => {
    const { headers } = await call('GET', '/device/config', { token: device.token });
    assert(
      (headers.get('cache-control') ?? '').includes('no-store'),
      'no Cache-Control: no-store — a proxy may be keeping a copy of key material',
    );
  });

  await check('the config is complete enough to hand to wg-quick', async () => {
    const { body } = await call('GET', '/device/config', { token: device.token });
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
      // Not instant: the agent pulls it within one poll interval.
      await waitForPeer(device.publicKey, { present: true });
    });
  } else {
    skip('the device reaches the interface', 'pass --check-wg on a node');
  }

  await check('the address came from the configured pool', async () => {
    const location = device.locations[0];
    assert(
      /^\d+\.\d+\.\d+\.\d+\/32$/.test(location.allowedIp),
      `allowedIp looks wrong: ${location.allowedIp}`,
    );
    // A location with no endpoint renders a config that can never handshake,
    // and nothing downstream would say why.
    assert(location.endpoint, `no endpoint reported for region ${location.region}`);
  });

  await check('rotating keeps the device identity and drops the old key', async () => {
    const rotated = clientKeypair();
    const { body } = await call('POST', '/device/rotate', {
      token: device.token,
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

    if (flags.has('--check-wg')) {
      await waitForPeer(rotated.publicKey, { present: true });
      // The whole point of rotation: a leaked config expires by itself.
      await waitForPeer(device.publicKey, { present: false });
    }
    device.publicKey = rotated.publicKey;
  });

  await check('rotation did not consume a device slot', async () => {
    const { body } = await call('GET', '/device', { token: device.token, expect: 200 });
    assertEqual(body.device.id, device.id, 'device id');
  });

  await check('a malformed public key is rejected', async () => {
    await call('POST', '/enroll', {
      body: { inviteToken, publicKey: 'not-a-key' },
      expect: 400,
    });
  });

  group('Isolation and limits');

  const second = await enrol('Acceptance second');

  await check('a device token names one device and cannot name another', async () => {
    // There is no id in any path, so this is structural rather than checked:
    // the only device a token can reach is its own. That is the property.
    const { body } = await call('GET', '/device', { token: second.token, expect: 200 });
    assertEqual(body.device.id, second.id, 'device id');
    assert(body.device.id !== device.id, 'the second token resolved to the first device');
  });

  await check('one config never mentions the other device key', async () => {
    const { body } = await call('GET', '/device/config', { token: second.token });
    assert(!body.conf.includes(device.publicKey), 'the config carries another device key');
  });

  await check('a device removing itself frees its address', async () => {
    const victim = enrolled.pop();
    const address = victim.locations[0].allowedIp;
    await call('DELETE', '/device', { token: victim.token, expect: 204 });

    // Its own token is dead the moment it is gone.
    await call('GET', '/device', { token: victim.token, expect: 401 });

    // There is no device quota — the address pool is what bounds enrolment —
    // so the thing worth checking is that a removed device gives its address
    // back rather than leaving a hole in the pool.
    const replacement = await enrol('replacement');
    assert(replacement.id !== victim.id, 'the replacement reused the removed id');
    assertEqual(replacement.locations[0].allowedIp, address, 'the freed address');
  });

  group('Input handling');

  await check('malformed JSON returns 400, not 500', async () => {
    const response = await fetch(`${baseUrl}/enroll`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"inviteToken": "x", ',
    });
    assertEqual(response.status, 400, 'status');
  });

  await check('an oversized body returns 413, not 500', async () => {
    const response = await fetch(`${baseUrl}/enroll`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ inviteToken, label: 'x'.repeat(200_000) }),
    });
    assert(
      response.status === 413 || response.status === 400,
      `expected 413, got ${response.status} — a 500 means the error handler is not catching body-parser errors`,
    );
  });

  await check('a device label has nowhere to land', async () => {
    // This used to check that a label with a newline in it was rejected before
    // it could reach the rendered config, where a line of its own is a
    // directive. Labels are not stored at all now, so the field is accepted
    // and discarded — the injection has nothing left to inject into.
    const { body } = await call('POST', '/enroll', {
      body: {
        inviteToken,
        label: 'evil\nAllowedIPs = 10.0.0.0/8',
        publicKey: clientKeypair().publicKey,
      },
      expect: 201,
    });

    assert(!body.conf.includes('10.0.0.0/8'), 'the label reached the config');
    assert(!JSON.stringify(body).includes('evil'), 'the label came back');
    enrolled.push({ token: body.deviceToken, id: body.device.id });
  });

  await check('the server volunteers nothing about the device', async () => {
    // The privacy claim, checked from outside: what comes back describes a
    // tunnel, not a person. No name, no platform, no dates, no counters.
    const { body } = await call('GET', '/device', { token: device.token, expect: 200 });
    const fields = Object.keys(body.device).sort().join(',');

    assertEqual(fields, 'id,locations,publicKey', 'device fields');
    assert(!/\d{4}-\d{2}-\d{2}T/.test(JSON.stringify(body)), 'a timestamp came back');
  });

  if (flags.has('--rate-limits')) {
    group('Rate limiting');
    await check('repeated enrolment attempts are throttled', async () => {
      let throttled = false;
      for (let i = 0; i < 40; i += 1) {
        const response = await call('POST', '/enroll', {
          body: { inviteToken: 'ZZZZZZZZZZ', publicKey: clientKeypair().publicKey },
        });
        if (response.status === 429) {
          throttled = true;
          break;
        }
      }
      assert(throttled, 'no 429 after 40 attempts — the limiter is off or TRUST_PROXY is wrong');
    });
  } else {
    skip('rate limiting', 'pass --rate-limits; it locks this IP out for a while');
  }

  group('Cleanup');

  await check('every device this run created removes itself', async () => {
    for (const created of enrolled) {
      await call('DELETE', '/device', { token: created.token, expect: 204 });
    }
    // Addresses go back to the pool; nothing is left holding one.
    await call('GET', '/device', { token: device.token, expect: 401 });
  });

  if (flags.has('--check-wg')) {
    await check('the agent removed them from the interface', async () => {
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
    `\n${c.yellow('Devices may be left behind. `vpn reset --kick` removes all of them.')}`,
  );
}

process.exit(results.failed > 0 ? 1 : 0);

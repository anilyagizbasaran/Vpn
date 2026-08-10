#!/usr/bin/env node
/**
 * Defines a VPN node and mints its agent token.
 *
 * The token is printed once and stored only as an HMAC, the same way refresh
 * tokens are: a leaked database gives an attacker no way to impersonate a
 * node. Re-running for an existing region updates its settings and, with
 * --rotate-token, issues a new token — which is how a node is decommissioned
 * without touching the others.
 *
 *   npm run node:add -- --region nl-ams --display "Amsterdam" \
 *     --endpoint ams.example.com:51820 --public-key <wg pubkey> \
 *     --pool 10.9.0.0/24
 *
 *   npm run node:add -- --region nl-ams --rotate-token
 *   npm run node:add -- --region nl-ams --status draining
 */

import { randomBytes } from 'node:crypto';
import { createContainer } from '../dist/container.js';
import { hashNodeToken } from '../dist/services/nodeService.js';
import { env } from '../dist/config/env.js';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith('--')) continue;
    const name = key.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      args[name] = true;
    } else {
      args[name] = next;
      i += 1;
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

if (!args.region) {
  console.error(`Define or update a VPN node.

Required for a new node:
  --region <slug>          unique identifier, e.g. nl-ams
  --endpoint <host:port>   what clients dial
  --public-key <key>       the node's WireGuard interface key
  --pool <cidr>            address pool, e.g. 10.9.0.0/24

Optional:
  --display <name>         shown in the region picker (defaults to the region)
  --address <ip>           the node's own tunnel address (defaults to pool + 1)
  --dns <servers>          pushed to clients
  --interface <name>       defaults to wg0
  --listen-port <port>     defaults to 51820
  --default                make this the region new clients get
  --status <s>             active | draining | offline
  --rotate-token           issue a new agent token, invalidating the old one
`);
  process.exit(2);
}

const container = await createContainer({ skipBootstrapNode: true });

try {
  const existing = await container.repos.servers.findByRegion(args.region);

  if (!existing && !(args.endpoint && args['public-key'] && args.pool)) {
    console.error(
      `Region "${args.region}" does not exist yet, so --endpoint, --public-key and --pool are required.`,
    );
    process.exit(2);
  }

  // The node's own address defaults to the first host in the pool, matching
  // what setup-wg.sh configures on the machine.
  const derivedAddress = () => {
    const [base] = (args.pool ?? existing.addressPoolCidr).split('/');
    const octets = base.split('.').map(Number);
    octets[3] += 1;
    return octets.join('.');
  };

  const server = await container.repos.servers.upsertByRegion({
    region: args.region,
    displayName: args.display ?? existing?.displayName ?? args.region,
    publicKey: args['public-key'] ?? existing.publicKey,
    endpoint: args.endpoint ?? existing.endpoint,
    listenPort: Number(args['listen-port'] ?? existing?.listenPort ?? 51820),
    interfaceName: args.interface ?? existing?.interfaceName ?? 'wg0',
    addressPoolCidr: args.pool ?? existing.addressPoolCidr,
    serverAddress: args.address ?? existing?.serverAddress ?? derivedAddress(),
    dns: args.dns ?? existing?.dns ?? '1.1.1.1, 1.0.0.1',
    isDefault: args.default === true ? true : (existing?.isDefault ?? false),
    status: args.status ?? existing?.status ?? 'active',
    // Never passed on an update: upsertByRegion keeps the existing token, so
    // a settings change cannot lock a running agent out.
    agentTokenHash: null,
  });

  const needsToken = args['rotate-token'] === true || !server.agentTokenHash;
  let token = null;

  if (needsToken) {
    token = `vpnnode_${randomBytes(32).toString('base64url')}`;
    await container.repos.servers.setAgentTokenHash(
      server.id,
      hashNodeToken(env.JWT_REFRESH_PEPPER, token),
    );
  }

  console.log(`
Node ${existing ? 'updated' : 'created'}: ${server.displayName} (${server.region})
  id           ${server.id}
  endpoint     ${server.endpoint}
  interface    ${server.interfaceName}
  pool         ${server.addressPoolCidr}  (node at ${server.serverAddress})
  status       ${server.status}${server.isDefault ? '  [default region]' : ''}
`);

  if (token) {
    console.log(`Agent token — shown once, store it on the node:

  ${token}

On the node:
  VPN_CONTROL_PLANE=https://api.example.com \\
  VPN_NODE_TOKEN=${token} \\
  vpn-node-agent
`);
    if (args['rotate-token']) {
      console.log('The previous token stopped working the moment this one was issued.\n');
    }
  } else {
    console.log('The existing agent token was left alone. Use --rotate-token to replace it.\n');
  }
} finally {
  container.close();
}

/**
 * Mints, lists and revokes invites.
 *
 * This is the whole of user management. There is no registration to moderate
 * and no password to reset, because an invite is the only thing that says
 * somebody is allowed on — minting one is letting them in, revoking it is
 * taking them out, and it takes their devices with it.
 *
 *   npm run invite -- --label "Ali" --devices 3
 *   npm run invite -- --list
 *   npm run invite -- --revoke 4
 *
 * The token is printed once. Only its HMAC is stored, so it cannot be shown
 * again — the same rule the node agent tokens follow.
 */
import { createContainer } from '../dist/container.js';

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
const container = await createContainer({ skipBootstrapNode: true });

try {
  if (args.list === true) {
    const invites = await container.invites.list();
    if (invites.length === 0) {
      console.log('\nNo invites yet. Create one with:\n  npm run invite -- --label "phone"\n');
    } else {
      console.log('');
      for (const invite of invites) {
        const devices = await container.repos.devices.countActiveByInvite(invite.id);
        const state = invite.revokedAt ? 'revoked' : 'active';
        console.log(
          `  ${String(invite.id).padStart(3)}  ${invite.label.padEnd(20)} ` +
            `${devices}/${invite.deviceLimit} devices  ${state}` +
            (invite.lastUsedAt ? `  last used ${invite.lastUsedAt.slice(0, 10)}` : '  never used'),
        );
      }
      console.log('');
    }
    process.exit(0);
  }

  if (args.revoke) {
    const id = Number(args.revoke);
    if (!Number.isInteger(id)) {
      console.error('--revoke takes an invite id; see --list');
      process.exit(2);
    }
    const revoked = await container.invites.revoke(id);
    console.log(
      revoked
        ? `\nInvite ${id} revoked. Its devices stop working on the nodes' next sync.\n`
        : `\nInvite ${id} was already revoked, or does not exist.\n`,
    );
    process.exit(revoked ? 0 : 1);
  }

  if (!args.label) {
    console.error(`Mint an invite: permission for someone to enrol devices.

  --label <name>     who or what it is for, e.g. "Ali" or "phone"
  --devices <n>      how many devices it may enrol at once (default 5)

  --list             show every invite and how it is used
  --revoke <id>      revoke one, taking its devices with it
`);
    process.exit(2);
  }

  const deviceLimit = args.devices ? Number(args.devices) : 5;
  if (!Number.isInteger(deviceLimit) || deviceLimit < 1 || deviceLimit > 100) {
    console.error('--devices must be a whole number between 1 and 100');
    process.exit(2);
  }

  const { invite, token } = await container.invites.mint({
    label: String(args.label),
    deviceLimit,
  });

  if (args['token-only'] === true) {
    console.log(token);
    process.exit(0);
  }

  console.log(`
Invite ${invite.id} created for "${invite.label}" — up to ${invite.deviceLimit} devices.

Give them this code. It is shown once:

  ${token}

They enter it in the app along with this server's address. Nothing else: no
account, no password. Revoke it with:

  npm run invite -- --revoke ${invite.id}
`);
} finally {
  container.close();
}

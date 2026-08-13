/**
 * The whole of user management, as four verbs.
 *
 *   vpn status              is a code set, and how many devices are on it
 *   vpn devices             one line per device: what it is, when, how much
 *   vpn revoke <id>         cut off one device, freeing its address
 *   vpn reset [--kick]      new code; --kick also removes every device
 *
 * There is nothing else, because there is nothing else to manage. No accounts
 * to moderate, no passwords to reset, no sessions to expire. One code lets a
 * device on; rotating it is how a code that got out stops working.
 *
 * A code is shown once and stored only as an HMAC, so `status` can tell you a
 * code exists but never what it is. Losing it is not a problem worth solving
 * separately: `reset` gives you a new one and leaves your devices connected.
 */
import { createContainer } from '../dist/container.js';

const BOLD = '[1m';
const DIM = '[90m';
const RESET = '[0m';

/** The one invite this server hands out. */
const LABEL = 'default';

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith('--')) {
      args._.push(item);
      continue;
    }
    const name = item.slice(2);
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

/** Bytes as something a person reads without counting digits. */
function humanBytes(bytes) {
  if (!bytes) return '0';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(units.length - 1, Math.floor(Math.log10(bytes) / 3));
  return `${(bytes / 1000 ** index).toFixed(index === 0 ? 0 : 1)}${units[index]}`;
}

/** "3 days ago", or "never". Absolute dates make you do arithmetic. */
function ago(iso) {
  if (!iso) return 'never';
  const seconds = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (seconds < 90) return 'just now';
  if (seconds < 5400) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 172_800) return `${Math.round(seconds / 3600)} hours ago`;
  return `${Math.round(seconds / 86_400)} days ago`;
}

function printCode(token) {
  console.log(`
  ${BOLD}${token}${RESET}

  Enter this in the app, the browser extension, or on your phone, along with
  this server's address. It is shown once — if you lose it, run ${BOLD}vpn reset${RESET}
  for a new one; the devices already connected are not disturbed.
`);
}

const args = parseArgs(process.argv.slice(2));
const command = args._[0] ?? 'status';
const container = await createContainer({ skipBootstrapNode: true });

/** The single invite, created on first use so no command ever has to fail. */
async function theInvite() {
  const existing = (await container.repos.invites.list()).find(
    (invite) => invite.label === LABEL,
  );
  if (existing) return { invite: existing, token: null };

  const minted = await container.invites.mint({ label: LABEL });
  return { invite: minted.invite, token: minted.token };
}

try {
  if (command === 'status') {
    const { invite, token } = await theInvite();
    const devices = await container.repos.devices.countActiveByInvite(invite.id);

    // For the installer: print the code alone, and only when this run is what
    // created it. A re-run prints nothing rather than rotating, so updating
    // the server never invalidates a code somebody wrote down.
    if (args.quiet) {
      if (token) console.log(token);
      process.exit(0);
    }

    if (token) {
      console.log(`\n  ${DIM}No code existed yet, so here is one.${RESET}`);
      printCode(token);
    } else {
      console.log(`
  Code       ${BOLD}set${RESET} ${DIM}(shown only once, at reset)${RESET}
  Devices    ${BOLD}${devices}${RESET} connected${devices ? `  ${DIM}— see them with: vpn devices${RESET}` : ''}
  Last used  ${ago(invite.lastUsedAt)}
`);
    }
    process.exit(0);
  }

  if (command === 'devices') {
    const { invite } = await theInvite();
    const devices = await container.devices.listForInvite(invite.id);

    if (devices.length === 0) {
      console.log(`\n  No devices yet. Run ${BOLD}vpn reset${RESET} for a code, then enter it in the app.\n`);
      process.exit(0);
    }

    console.log('');
    for (const device of devices) {
      const traffic = device.usage
        ? `${humanBytes(device.usage.rxBytes + device.usage.txBytes)}`
        : '0';
      console.log(
        `  ${String(device.id).padStart(3)}  ${device.label.slice(0, 22).padEnd(24)}` +
          `${device.platform.padEnd(9)}${traffic.padStart(8)}   ` +
          `${DIM}enrolled ${ago(device.createdAt)}${RESET}`,
      );
    }
    console.log(`\n  ${DIM}Remove one with: vpn revoke <id>${RESET}\n`);
    process.exit(0);
  }

  if (command === 'revoke') {
    const id = Number(args._[1]);
    if (!Number.isInteger(id)) {
      console.error('\n  Usage: vpn revoke <id>   — the id from `vpn devices`\n');
      process.exit(2);
    }

    const device = await container.repos.devices.findById(id);
    if (!device || device.revokedAt) {
      console.error(`\n  No device ${id}. Run \`vpn devices\` to see the list.\n`);
      process.exit(1);
    }

    await container.devices.revokeOwn(device);
    console.log(
      `\n  Device ${id} (${device.label}) removed. It leaves the interface on the` +
        ` nodes' next sync,\n  and its address goes back into the pool.\n`,
    );
    process.exit(0);
  }

  if (command === 'reset') {
    const { invite, token } = await theInvite();
    if (token) {
      // Nothing existed, so the first code is the reset.
      printCode(token);
      process.exit(0);
    }

    // Order matters: devices are cut off before the new code is printed, so a
    // reset that is interrupted has removed access rather than only promised
    // to. Revoking the invite as well is deliberate belt-and-braces — rotate
    // clears the flag again a line later.
    let removed = 0;
    if (args.kick) {
      await container.invites.revoke(invite.id);
      removed = await container.devices.revokeAllForInvite(invite.id);
    }

    const rotated = await container.invites.rotate(invite.id);
    if (!rotated) {
      console.error('\n  Could not rotate the code.\n');
      process.exit(1);
    }

    console.log(
      args.kick
        ? `\n  ${BOLD}${removed} device${removed === 1 ? '' : 's'} removed${RESET} and the old code is dead.` +
            `\n  ${DIM}Every device has to be set up again with the code below.${RESET}`
        : `\n  Old code is dead. ${DIM}Devices already connected are unaffected —` +
            `\n  use ${RESET}vpn reset --kick${DIM} if you need them gone too.${RESET}`,
    );
    printCode(rotated.token);
    process.exit(0);
  }

  console.error(`
  Usage:
    vpn status              is a code set, and how many devices are on it
    vpn devices             one line per device
    vpn revoke <id>         cut off one device
    vpn reset               new code; devices stay connected
    vpn reset --kick        new code and remove every device

  vpn status --quiet prints a newly created code and nothing else, for scripts.
`);
  process.exit(2);
} finally {
  container.close();
}

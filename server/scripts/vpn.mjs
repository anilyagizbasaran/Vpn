/**
 * The whole of user management, as four verbs.
 *
 *   vpn status              is a code set, and how many devices it enrolled
 *   vpn howmanydevice       how many are connected right now (runs on the host)
 *   vpn reset [--kick]      new code; --kick also removes every device
 *
 * There is nothing else, because there is nothing else to manage. No accounts
 * to moderate, no passwords to reset, no sessions to expire. One code lets a
 * device on; rotating it is how a code that got out stops working.
 *
 * And nothing to browse: the database holds a key and an address per device
 * and not one thing more — no name, no platform, no dates, no byte counters.
 * A device list would have nothing to put in its columns.
 *
 * A code is shown once and stored only as an HMAC, so `status` can tell you a
 * code exists but never what it is. Losing it is not a problem worth solving
 * separately: `reset` gives you a new one and leaves your devices connected.
 */
import { createContainer } from '../dist/container.js';

const BOLD = '[1m';
const DIM = '[90m';
const RESET = '[0m';

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
  // The lowest id, because there is only ever one. This used to look the
  // invite up by a label — which stopped existing when the schema dropped
  // every field that was not needed to run a tunnel, so the lookup silently
  // matched nothing and every `vpn status` minted a fresh code.
  const [existing] = await container.repos.invites.list();
  if (existing) return { invite: existing, token: null };

  const minted = await container.invites.mint();
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
      // The code itself cannot be shown: only its HMAC is stored. So this says
      // what to do instead of what is missing — someone who lost their code
      // should not have to work out that a new one is free.
      console.log(`
  Code       ${BOLD}set${RESET} ${DIM}— not shown again; run ${RESET}vpn reset${DIM} for a new one${RESET}
  Devices    ${BOLD}${devices}${RESET} enrolled${devices ? `  ${DIM}— connected right now: vpn howmanydevice${RESET}` : ''}

  ${DIM}Only the code's HMAC is stored, so it cannot be read back. A new code
  costs nothing: the devices already connected keep working.${RESET}
`);
    }
    process.exit(0);
  }

  // There is no per-device revoke, because there is nothing to pick from: the
  // server holds a key and an address per device and nothing that says which
  // is whose. Cutting one person off without the others would need exactly the
  // record this server refuses to keep. `vpn reset --kick` removes everybody.

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
    vpn status              is a code set, and how many devices it enrolled
    vpn howmanydevice       how many are connected right now
    vpn reset               new code; devices stay connected
    vpn reset --kick        new code and remove every device

  vpn status --quiet prints a newly created code and nothing else, for scripts.
`);
  process.exit(2);
} finally {
  container.close();
}

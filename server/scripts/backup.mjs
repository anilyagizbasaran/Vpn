/**
 * The safety net `vpn update` falls back on, and nothing more.
 *
 *   node scripts/backup.mjs            write it
 *   node scripts/backup.mjs --discard  delete it
 *
 * One file, fixed name, deleted the moment the update it protects has
 * succeeded. Not an archive — deliberately.
 *
 * A dated series of backups would quietly undo what this server is for. The
 * database holds a key and an address per device and no history at all, so
 * `vpn reset --kick` really does remove a device. Keep five dated copies and
 * it does not: the removed devices are still in yesterday's file, and the file
 * names themselves say how many devices existed at which times. Anyone who
 * takes the disk gets the timeline the live database refuses to keep.
 *
 * `VACUUM INTO` rather than copying the file: SQLite in WAL mode keeps recent
 * writes in a side file, so `cp vpn.db` on a running server produces something
 * that opens fine and is missing the last few minutes.
 *
 * Prints the path, and nothing else, so a shell can capture it.
 */
import { existsSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { env } from '../dist/config/env.js';
import { openDatabase } from '../dist/db/sqlite.js';

// Beside the database, so it lives on the same volume and inherits the same
// permissions. Fixed name: there is only ever one, and it is temporary.
const target = join(dirname(resolve(env.DATABASE_PATH)), 'vpn-pre-update.db');

if (process.argv.includes('--discard')) {
  if (existsSync(target)) unlinkSync(target);
  console.error('  backup discarded');
  process.exit(0);
}

// Removed first: VACUUM INTO refuses to overwrite, and a backup left by an
// update that already finished is stale by definition.
if (existsSync(target)) unlinkSync(target);

const db = openDatabase(env.DATABASE_PATH);
try {
  // Bound as a parameter rather than concatenated: it is a path going into
  // SQL, and that stays true however the path is built later.
  db.prepare('VACUUM INTO ?').run(target);
} finally {
  db.close();
}

console.log(target);

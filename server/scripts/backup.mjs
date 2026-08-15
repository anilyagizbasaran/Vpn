/**
 * A consistent copy of the database, for `vpn update` to fall back on.
 *
 *   node scripts/backup.mjs [--keep N]
 *
 * `VACUUM INTO` rather than copying the file: SQLite in WAL mode keeps recent
 * writes in a side file, so `cp vpn.db` on a running server produces something
 * that opens fine and is missing the last few minutes. VACUUM INTO takes a
 * read lock and writes a complete, already-compacted database.
 *
 * Prints the path it wrote, and nothing else, so a shell can capture it.
 */
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

import { env } from '../dist/config/env.js';
import { openDatabase } from '../dist/db/sqlite.js';

const args = process.argv.slice(2);
const keepIndex = args.indexOf('--keep');
const keep = keepIndex === -1 ? 5 : Number(args[keepIndex + 1]);

if (!Number.isInteger(keep) || keep < 1) {
  console.error('--keep needs a positive whole number');
  process.exit(2);
}

const directory = join(env.DATABASE_PATH, '..', 'backups');
mkdirSync(directory, { recursive: true });

// Sortable, so the pruning below can order by name alone.
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

// VACUUM INTO refuses to overwrite, so a second backup in the same second
// would fail rather than replace one. Rare, but "back up before updating" is
// exactly the moment someone runs it twice in a row.
let target = join(directory, `vpn-${stamp}.db`);
for (let n = 2; existsSync(target); n += 1) {
  target = join(directory, `vpn-${stamp}-${n}.db`);
}

const db = openDatabase(env.DATABASE_PATH);
try {
  // Bound as a parameter: the path is built here, but VACUUM INTO takes an
  // expression and string-concatenating a path into SQL is how that stops
  // being true the first time someone makes the directory configurable.
  db.prepare('VACUUM INTO ?').run(target);
} finally {
  db.close();
}

// Old backups are deleted only after the new one exists, so a full disk leaves
// the previous backups rather than none.
// Ordered by write time, not by name. The two agree until a second backup
// lands in the same second, and then they do not: "vpn-…-12-2.db" sorts before
// "vpn-…-12.db" because a hyphen is below a dot, so the older file would look
// like the newer one and the newest would be the first thing deleted.
const existing = readdirSync(directory)
  .filter((name) => name.startsWith('vpn-') && name.endsWith('.db'))
  .map((name) => ({ name, at: statSync(join(directory, name)).mtimeMs }))
  .sort((a, b) => b.at - a.at)
  .map((entry) => entry.name);

for (const stale of existing.slice(keep)) {
  const path = join(directory, stale);
  try {
    unlinkSync(path);
  } catch {
    // A backup that will not delete is not a reason to fail a backup that
    // succeeded. The next run tries again.
  }
}

console.log(target);
console.error(`  ${statSync(target).size} bytes, keeping ${keep}`);

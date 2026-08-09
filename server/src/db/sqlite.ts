import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { logger } from '../utils/logger.js';
import { migrate } from './migrate.js';

export type Db = Database.Database;

export function openDatabase(path: string): Db {
  const isMemory = path === ':memory:' || path.startsWith('file::memory:');
  if (!isMemory) {
    const absolute = resolve(path);
    mkdirSync(dirname(absolute), { recursive: true });
    path = absolute;
  }

  const db = new Database(path);

  // WAL keeps readers from blocking the single writer; busy_timeout makes
  // concurrent writes wait instead of throwing SQLITE_BUSY straight away.
  if (!isMemory) db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');

  migrate(db);
  logger.info('database ready', { path: isMemory ? ':memory:' : path });
  return db;
}

import type Database from 'better-sqlite3';
import { logger } from '../utils/logger.js';

type Migration = { version: number; name: string; up: string };

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial schema',
    up: `
      CREATE TABLE users (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        email         TEXT    NOT NULL COLLATE NOCASE,
        password_hash TEXT    NOT NULL,
        created_at    TEXT    NOT NULL,
        disabled_at   TEXT
      );
      CREATE UNIQUE INDEX users_email_unique ON users (email COLLATE NOCASE);

      -- One row per WireGuard server. Present from day one (rather than
      -- hardcoding a single server in env) because peers.allowed_ip is only
      -- unique *within* a server's pool, and Phase 4 adds more regions.
      CREATE TABLE servers (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        region            TEXT    NOT NULL,
        public_key        TEXT    NOT NULL,
        endpoint          TEXT    NOT NULL,
        listen_port       INTEGER NOT NULL,
        interface_name    TEXT    NOT NULL DEFAULT 'wg0',
        address_pool_cidr TEXT    NOT NULL,
        server_address    TEXT    NOT NULL,
        dns               TEXT    NOT NULL DEFAULT '',
        is_default        INTEGER NOT NULL DEFAULT 0,
        created_at        TEXT    NOT NULL
      );
      CREATE UNIQUE INDEX servers_region_unique ON servers (region);

      CREATE TABLE peers (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id           INTEGER NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
        server_id         INTEGER NOT NULL REFERENCES servers(id) ON DELETE RESTRICT,
        public_key        TEXT    NOT NULL,
        preshared_key_enc TEXT,
        allowed_ip        TEXT    NOT NULL,
        device_label      TEXT    NOT NULL,
        created_at        TEXT    NOT NULL,
        revoked_at        TEXT
      );

      -- Partial uniqueness: two *live* peers can never share an address or a
      -- public key, but revoked rows stay for audit and release their IP back
      -- into the pool. This index is what makes concurrent POST /peers safe --
      -- the loser of a race gets a constraint error and retries.
      CREATE UNIQUE INDEX peers_active_ip_unique
        ON peers (server_id, allowed_ip) WHERE revoked_at IS NULL;
      CREATE UNIQUE INDEX peers_active_pubkey_unique
        ON peers (server_id, public_key) WHERE revoked_at IS NULL;
      CREATE INDEX peers_by_user ON peers (user_id, revoked_at);

      CREATE TABLE refresh_tokens (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash  TEXT    NOT NULL UNIQUE,
        family_id   TEXT    NOT NULL,
        expires_at  TEXT    NOT NULL,
        created_at  TEXT    NOT NULL,
        revoked_at  TEXT
      );
      CREATE INDEX refresh_tokens_family ON refresh_tokens (family_id);
      CREATE INDEX refresh_tokens_user   ON refresh_tokens (user_id);
      CREATE INDEX refresh_tokens_expiry ON refresh_tokens (expires_at);
    `,
  },
  {
    version: 2,
    name: 'track key rotation',
    up: `
      -- When the device last replaced its keypair. NULL means the key is the
      -- original one, so the client falls back to created_at to decide whether
      -- a rotation is due.
      ALTER TABLE peers ADD COLUMN key_rotated_at TEXT;
    `,
  },
  {
    version: 3,
    name: 'record the device platform',
    up: `
      -- Which kind of device this peer belongs to. Needed the moment the
      -- product stopped being mobile-only: a device list showing five
      -- identical rows called "My device" is useless for deciding which one
      -- to revoke. Defaulted rather than backfilled, because peers created
      -- before this migration genuinely are unknown.
      ALTER TABLE peers ADD COLUMN platform TEXT NOT NULL DEFAULT 'unknown';
    `,
  },
];

export function migrate(db: Database.Database): void {
  const current = db.pragma('user_version', { simple: true }) as number;

  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue;

    db.transaction(() => {
      db.exec(migration.up);
      // PRAGMA does not accept bound parameters; version is an integer literal
      // from this file, never user input.
      db.pragma(`user_version = ${migration.version}`);
    })();

    logger.info('migration applied', { version: migration.version, name: migration.name });
  }
}

export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;

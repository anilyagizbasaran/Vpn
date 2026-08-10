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
  {
    version: 4,
    name: 'split devices from peers, add node agents and usage',
    up: `
      -- Until now a peer *was* a device. With more than one server that breaks:
      -- a device needs an address on every server it can reach, and counting
      -- those against a five-device limit would let three regions exhaust a
      -- user's quota with one phone.
      --
      -- So the identity moves to devices (one keypair, what the quota counts)
      -- and peers become what they actually are: an address allocation binding
      -- one device to one server.
      CREATE TABLE devices (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        label          TEXT    NOT NULL,
        platform       TEXT    NOT NULL DEFAULT 'unknown',
        -- One key for every server. WireGuard authenticates per (client,
        -- server) pair, so the same client key peering with several servers is
        -- normal; it is what lets switching region be a config edit rather than
        -- a round trip.
        public_key     TEXT    NOT NULL,
        created_at     TEXT    NOT NULL,
        key_rotated_at TEXT,
        revoked_at     TEXT
      );
      CREATE UNIQUE INDEX devices_active_pubkey
        ON devices (public_key) WHERE revoked_at IS NULL;
      CREATE INDEX devices_by_user ON devices (user_id, revoked_at);

      INSERT INTO devices (id, user_id, label, platform, public_key,
                           created_at, key_rotated_at, revoked_at)
        SELECT id, user_id, device_label, platform, public_key,
               created_at, key_rotated_at, revoked_at
          FROM peers;

      CREATE TABLE peers_v4 (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        device_id         INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
        server_id         INTEGER NOT NULL REFERENCES servers(id) ON DELETE RESTRICT,
        allowed_ip        TEXT    NOT NULL,
        -- Preshared keys stay per (device, server): the secret is shared with
        -- that server and no other.
        preshared_key_enc TEXT,
        created_at        TEXT    NOT NULL,
        revoked_at        TEXT
      );

      -- device_id = old peer id works because devices kept the same ids above.
      INSERT INTO peers_v4 (id, device_id, server_id, allowed_ip,
                            preshared_key_enc, created_at, revoked_at)
        SELECT id, id, server_id, allowed_ip,
               preshared_key_enc, created_at, revoked_at
          FROM peers;

      DROP TABLE peers;
      ALTER TABLE peers_v4 RENAME TO peers;

      CREATE UNIQUE INDEX peers_active_ip_unique
        ON peers (server_id, allowed_ip) WHERE revoked_at IS NULL;
      -- A device gets at most one address per server. Without this a retry
      -- storm could allocate a device several addresses on the same node.
      CREATE UNIQUE INDEX peers_active_device_server
        ON peers (device_id, server_id) WHERE revoked_at IS NULL;
      CREATE INDEX peers_by_device ON peers (device_id, revoked_at);
      CREATE INDEX peers_by_server ON peers (server_id, revoked_at);

      -- Servers become nodes the control plane talks to rather than the
      -- interface it happens to be running on.
      ALTER TABLE servers ADD COLUMN display_name TEXT NOT NULL DEFAULT '';
      -- active | draining | offline. A draining node stops taking new
      -- allocations without disconnecting anyone, which is how a node is
      -- retired without an outage.
      ALTER TABLE servers ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
      -- HMAC of the agent's bearer token, never the token itself.
      ALTER TABLE servers ADD COLUMN agent_token_hash TEXT;
      ALTER TABLE servers ADD COLUMN last_seen_at TEXT;
      ALTER TABLE servers ADD COLUMN agent_version TEXT;
      -- What the agent says its interface key is. Compared against public_key
      -- so a node rebuilt with a new key is reported instead of silently
      -- handing every client a config that can never handshake.
      ALTER TABLE servers ADD COLUMN reported_public_key TEXT;
      CREATE UNIQUE INDEX servers_agent_token
        ON servers (agent_token_hash) WHERE agent_token_hash IS NOT NULL;

      -- Usage, as reported by the agent from its interface dump.
      CREATE TABLE peer_usage (
        peer_id           INTEGER PRIMARY KEY REFERENCES peers(id) ON DELETE CASCADE,
        rx_bytes          INTEGER NOT NULL DEFAULT 0,
        tx_bytes          INTEGER NOT NULL DEFAULT 0,
        -- WireGuard's counters restart whenever a peer is re-added, so the
        -- last raw reading is kept to tell a reset apart from a rollback.
        last_rx_counter   INTEGER NOT NULL DEFAULT 0,
        last_tx_counter   INTEGER NOT NULL DEFAULT 0,
        last_handshake_at TEXT,
        updated_at        TEXT    NOT NULL
      );
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

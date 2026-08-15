import type Database from 'better-sqlite3';
import { logger } from '../utils/logger.js';

type Migration = { version: number; name: string; up: string };

/** Exported so tests can build a database at an older version on purpose. */
export const MIGRATIONS: Migration[] = [
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
      -- into the pool. This index is what makes concurrent POST /devices safe --
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
  {
    version: 5,
    name: 'add invites alongside accounts',
    up: `
      -- Accounts are the wrong shape for a self-hosted VPN: registering,
      -- signing in and rotating refresh tokens is a lot of machinery to decide
      -- something the operator already knows — whether this person is allowed
      -- on. An invite says that and nothing more.
      --
      -- Added alongside rather than instead of. Both owners work for now, so
      -- the clients can move over one at a time and every step in between is a
      -- state the tests still pass in. Accounts come out in a later migration,
      -- once nothing enrols through them.
      --
      -- What does not change: an invite is an enrolment credential, not a key.
      -- The client still generates its own pair and still sends only the
      -- public half, so a stolen server disk decrypts nothing.
      CREATE TABLE invites (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        label        TEXT    NOT NULL,
        -- HMAC, for the same reason refresh tokens are stored hashed: a leaked
        -- database must not hand anyone a working credential.
        token_hash   TEXT    NOT NULL UNIQUE,
        device_limit INTEGER NOT NULL DEFAULT 5,
        created_at   TEXT    NOT NULL,
        last_used_at TEXT,
        revoked_at   TEXT
      );

      -- SQLite cannot relax a NOT NULL in place, so the table is rebuilt. Both
      -- owner columns are nullable and a CHECK keeps a device from having
      -- neither — the transitional shape, not the destination.
      CREATE TABLE devices_v5 (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id        INTEGER REFERENCES users(id)   ON DELETE CASCADE,
        invite_id      INTEGER REFERENCES invites(id) ON DELETE CASCADE,
        label          TEXT    NOT NULL,
        platform       TEXT    NOT NULL DEFAULT 'unknown',
        public_key     TEXT    NOT NULL,
        -- Issued at enrolment so a device can fetch its config, rotate its key
        -- and revoke itself without holding the invite. Null for devices that
        -- came from an account and authenticate with a JWT instead.
        token_hash     TEXT    UNIQUE,
        created_at     TEXT    NOT NULL,
        key_rotated_at TEXT,
        revoked_at     TEXT,
        CHECK (user_id IS NOT NULL OR invite_id IS NOT NULL)
      );

      INSERT INTO devices_v5 (id, user_id, invite_id, label, platform,
                              public_key, token_hash, created_at,
                              key_rotated_at, revoked_at)
        SELECT id, user_id, NULL, label, platform,
               public_key, NULL, created_at, key_rotated_at, revoked_at
          FROM devices;

      DROP TABLE devices;
      ALTER TABLE devices_v5 RENAME TO devices;

      CREATE UNIQUE INDEX devices_active_pubkey
        ON devices (public_key) WHERE revoked_at IS NULL;
      CREATE INDEX devices_by_user   ON devices (user_id, revoked_at);
      CREATE INDEX devices_by_invite ON devices (invite_id, revoked_at);
    `,
  },
  {
    version: 6,
    name: 'remove accounts',
    up: `
      -- The other half of v5. Nothing enrols through an account any more: the
      -- routes are gone, the clients are gone, and a device is named by its own
      -- token rather than by whoever owns it.
      --
      -- This deletes data, and it is worth being plain about which. A device
      -- left over from the account era has invite_id NULL and token_hash NULL:
      -- no credential it could ever authenticate with, since the login that
      -- used to speak for it no longer exists. Keeping such rows would mean a
      -- device nobody can use holding an address nobody can reclaim, so they go
      -- — and with them, by cascade, their peer allocations and usage rows.
      -- The addresses return to the pool. Anyone affected enrols again with an
      -- invite code, which is one screen and no worse than a re-install.
      --
      -- Spelled out in three statements rather than leaning on ON DELETE
      -- CASCADE, because migrations run with foreign keys disabled (see the
      -- migrate function below) and the cascade would not fire. Left implicit,
      -- this deletes the devices and strands their peers holding addresses
      -- nothing can reclaim.
      DELETE FROM peer_usage WHERE peer_id IN (
        SELECT p.id FROM peers p
          JOIN devices d ON d.id = p.device_id
         WHERE d.invite_id IS NULL
      );
      DELETE FROM peers WHERE device_id IN (
        SELECT id FROM devices WHERE invite_id IS NULL
      );
      DELETE FROM devices WHERE invite_id IS NULL;

      -- Rebuilt rather than altered: what changes is a NOT NULL and a dropped
      -- CHECK, neither of which SQLite can do in place.
      CREATE TABLE devices_v6 (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        invite_id      INTEGER NOT NULL REFERENCES invites(id) ON DELETE CASCADE,
        label          TEXT    NOT NULL,
        platform       TEXT    NOT NULL DEFAULT 'unknown',
        public_key     TEXT    NOT NULL,
        -- Now mandatory. A device that cannot authenticate as itself is not a
        -- state the schema should be able to represent.
        token_hash     TEXT    NOT NULL UNIQUE,
        created_at     TEXT    NOT NULL,
        key_rotated_at TEXT,
        revoked_at     TEXT
      );

      INSERT INTO devices_v6 (id, invite_id, label, platform, public_key,
                              token_hash, created_at, key_rotated_at, revoked_at)
        SELECT id, invite_id, label, platform, public_key,
               token_hash, created_at, key_rotated_at, revoked_at
          FROM devices;

      DROP TABLE devices;
      ALTER TABLE devices_v6 RENAME TO devices;

      CREATE UNIQUE INDEX devices_active_pubkey
        ON devices (public_key) WHERE revoked_at IS NULL;
      CREATE INDEX devices_by_invite ON devices (invite_id, revoked_at);

      -- Nothing references these any more. refresh_tokens goes first: it is
      -- the table that made accounts expensive, and every row in it is a
      -- credential for a login route that no longer exists.
      DROP TABLE refresh_tokens;
      DROP TABLE users;
    `,
  },
  {
    version: 7,
    name: 'let an invite carry no device limit',
    up: `
      -- The quota was inherited from the account era, where it existed to stop
      -- one subscription being shared with a street. On a server its owner
      -- runs, it mostly fired at the wrong moment: reinstall a laptop and the
      -- slot stays taken, because only the device itself could give it back.
      --
      -- NULL now means no cap. What actually bounds enrolment is the address
      -- pool — a /24 is 253 devices — and what bounds a leaked code is being
      -- able to rotate it in one command.
      CREATE TABLE invites_v7 (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        label        TEXT    NOT NULL,
        token_hash   TEXT    NOT NULL UNIQUE,
        device_limit INTEGER,
        created_at   TEXT    NOT NULL,
        last_used_at TEXT,
        revoked_at   TEXT
      );

      -- Existing invites keep the cap they were minted with; changing somebody
      -- else's limit is not this migration's business.
      INSERT INTO invites_v7 (id, label, token_hash, device_limit,
                              created_at, last_used_at, revoked_at)
        SELECT id, label, token_hash, device_limit,
               created_at, last_used_at, revoked_at
          FROM invites;

      DROP TABLE invites;
      ALTER TABLE invites_v7 RENAME TO invites;

      -- devices is untouched: its rows keep their invite_id, the same ids go
      -- back into the rebuilt table, and foreign_key_check at the end of the
      -- run is what proves the references still resolve. Its indexes belong to
      -- that table and survive too, so there is nothing to recreate here.
    `,
  },
  {
    version: 8,
    name: 'keep nothing but what a tunnel needs',
    up: `
      -- A VPN's database is a record of who was where and when, and the safest
      -- thing to do with that record is not to have one.
      --
      -- What goes: device labels and platforms, every timestamp, and the whole
      -- usage table — bytes transferred and last-handshake times, per device.
      -- None of it is needed to carry a packet; all of it answers questions
      -- about a person.
      --
      -- What stays, and why it has to:
      --
      --   public_key   WireGuard authenticates a peer by its key. Without it
      --                there is no tunnel. It is not a name, but it is stable,
      --                and pretending otherwise would be dishonest.
      --   allowed_ip   Every peer needs an address inside the tunnel, and the
      --                same one each time, or its traffic has nowhere to go.
      --   token_hash   How a device fetches its own config and removes itself.
      --                An HMAC, so the row is not a usable credential.
      --
      -- Revocation becomes a real DELETE rather than a revoked_at column: a
      -- timestamp saying when somebody was cut off is exactly the kind of
      -- history this migration exists to stop keeping.
      DROP TABLE IF EXISTS peer_usage;

      CREATE TABLE invites_v8 (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        token_hash   TEXT    NOT NULL UNIQUE,
        device_limit INTEGER
      );
      INSERT INTO invites_v8 (id, token_hash, device_limit)
        SELECT id, token_hash, device_limit FROM invites WHERE revoked_at IS NULL;

      CREATE TABLE devices_v8 (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        invite_id  INTEGER NOT NULL REFERENCES invites_v8(id) ON DELETE CASCADE,
        public_key TEXT    NOT NULL UNIQUE,
        token_hash TEXT    NOT NULL UNIQUE
      );
      INSERT INTO devices_v8 (id, invite_id, public_key, token_hash)
        SELECT d.id, d.invite_id, d.public_key, d.token_hash
          FROM devices d
          JOIN invites_v8 i ON i.id = d.invite_id
         WHERE d.revoked_at IS NULL;

      CREATE TABLE peers_v8 (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        device_id         INTEGER NOT NULL REFERENCES devices_v8(id) ON DELETE CASCADE,
        server_id         INTEGER NOT NULL REFERENCES servers(id)    ON DELETE RESTRICT,
        allowed_ip        TEXT    NOT NULL,
        preshared_key_enc TEXT
      );
      INSERT INTO peers_v8 (id, device_id, server_id, allowed_ip, preshared_key_enc)
        SELECT p.id, p.device_id, p.server_id, p.allowed_ip, p.preshared_key_enc
          FROM peers p
          JOIN devices_v8 d ON d.id = p.device_id
         WHERE p.revoked_at IS NULL;

      DROP TABLE peers;
      DROP TABLE devices;
      DROP TABLE invites;
      ALTER TABLE peers_v8   RENAME TO peers;
      ALTER TABLE devices_v8 RENAME TO devices;
      ALTER TABLE invites_v8 RENAME TO invites;

      -- Plain UNIQUE now, not partial: with rows deleted rather than flagged,
      -- there is no such thing as a dead row to exclude.
      CREATE UNIQUE INDEX peers_ip_unique     ON peers (server_id, allowed_ip);
      CREATE UNIQUE INDEX peers_device_server ON peers (device_id, server_id);
      CREATE INDEX devices_by_invite ON devices (invite_id);
      CREATE INDEX peers_by_device   ON peers (device_id);
      CREATE INDEX peers_by_server   ON peers (server_id);
    `,
  },
];

export function migrate(db: Database.Database): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  const pending = MIGRATIONS.filter((migration) => migration.version > current);
  if (pending.length === 0) return;

  // Foreign keys go off for the duration, which is SQLite's documented
  // procedure for rebuilding a table (https://sqlite.org/lang_altertable.html).
  //
  // This is not a nicety. Several migrations rebuild `devices` by copying rows
  // into a new table and dropping the old one — and `peers.device_id` cascades
  // on delete, so with enforcement on, `DROP TABLE devices` deletes every
  // address allocation in the database, including those of the devices the
  // migration just carefully preserved. The devices survive with no peers, the
  // agent hands out nothing for them, and every client sits on "connecting"
  // forever with nothing anywhere saying why.
  //
  // The pragma is a no-op inside a transaction, so it has to be set out here.
  const enforced = db.pragma('foreign_keys', { simple: true }) === 1;
  if (enforced) db.pragma('foreign_keys = OFF');

  try {
    for (const migration of pending) {
      db.transaction(() => {
        db.exec(migration.up);
        // PRAGMA does not accept bound parameters; version is an integer literal
        // from this file, never user input.
        db.pragma(`user_version = ${migration.version}`);
      })();

      logger.info('migration applied', { version: migration.version, name: migration.name });
    }
  } finally {
    if (enforced) db.pragma('foreign_keys = ON');
  }

  // Turning enforcement off means a migration *could* leave a dangling
  // reference behind. Better to refuse to start than to serve peers pointing at
  // devices that are gone.
  const violations = db.pragma('foreign_key_check') as unknown[];
  if (violations.length > 0) {
    throw new Error(
      `Migration left ${violations.length} foreign key violation(s): ` +
        JSON.stringify(violations.slice(0, 5)),
    );
  }
}

export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;

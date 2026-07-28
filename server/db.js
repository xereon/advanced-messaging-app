// db.js — SQLite persistence via Node's built-in node:sqlite. No ORM, no deps.
// Every query is a prepared statement; nothing is string-concatenated.

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

let db = null;

export function open(file) {
  mkdirSync(dirname(file), { recursive: true });
  db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  migrate();
  return db;
}

export function handle() {
  if (!db) throw new Error('Database not opened');
  return db;
}

export function close() { db?.close(); db = null; }

function migrate() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      email         TEXT UNIQUE,
      pw_hash       TEXT,
      pw_salt       TEXT,
      pin_hash      TEXT,
      pin_salt      TEXT,
      avatar_color  TEXT NOT NULL DEFAULT '#2458E6',
      role          TEXT,
      is_guest      INTEGER NOT NULL DEFAULT 0,
      is_bot        INTEGER NOT NULL DEFAULT 0,
      retired       INTEGER NOT NULL DEFAULT 0,
      created_at    INTEGER NOT NULL,
      last_seen     INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token_hash  TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      method      TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      expires_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

    CREATE TABLE IF NOT EXISTS credentials (
      credential_id  TEXT PRIMARY KEY,
      user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      public_key     TEXT NOT NULL,
      alg            INTEGER NOT NULL,
      sign_count     INTEGER NOT NULL DEFAULT 0,
      label          TEXT,
      created_at     INTEGER NOT NULL,
      last_used_at   INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_credentials_user ON credentials(user_id);

    -- Challenges are single-use and short-lived; rows are deleted on redemption.
    CREATE TABLE IF NOT EXISTS webauthn_challenges (
      challenge   TEXT PRIMARY KEY,
      user_id     TEXT,
      purpose     TEXT NOT NULL,
      expires_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS attachments (
      id          TEXT PRIMARY KEY,
      msg_id      TEXT REFERENCES messages(id) ON DELETE CASCADE,
      convo_id    TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name        TEXT NOT NULL,
      mime        TEXT NOT NULL,
      size        INTEGER NOT NULL,
      width       INTEGER,
      height      INTEGER,
      path        TEXT NOT NULL,
      created_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_attachments_msg ON attachments(msg_id);

    -- Password resets are a separate ceremony from sign-in codes, so a code
    -- issued for one can never be redeemed for the other.
    CREATE TABLE IF NOT EXISTS reset_codes (
      email       TEXT PRIMARY KEY,
      code_hash   TEXT NOT NULL,
      expires_at  INTEGER NOT NULL,
      attempts    INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS login_codes (
      email       TEXT PRIMARY KEY,
      code_hash   TEXT NOT NULL,
      expires_at  INTEGER NOT NULL,
      attempts    INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id          TEXT PRIMARY KEY,
      type        TEXT NOT NULL,
      title       TEXT,
      created_at  INTEGER NOT NULL,
      created_by  TEXT REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS members (
      convo_id  TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      PRIMARY KEY (convo_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_members_user ON members(user_id);

    CREATE TABLE IF NOT EXISTS messages (
      id           TEXT PRIMARY KEY,
      convo_id     TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      from_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      text         TEXT NOT NULL,
      at           INTEGER NOT NULL,
      seq          INTEGER NOT NULL,
      reply_to     TEXT,
      edited_at    INTEGER,
      deleted_at   INTEGER,
      delivered_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_messages_convo ON messages(convo_id, at);
    CREATE INDEX IF NOT EXISTS idx_messages_seq ON messages(seq);
    CREATE INDEX IF NOT EXISTS idx_messages_from ON messages(from_id);

    CREATE TABLE IF NOT EXISTS reactions (
      msg_id   TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      emoji    TEXT NOT NULL,
      PRIMARY KEY (msg_id, user_id, emoji)
    );

    -- 'private' is set when the reader has read receipts switched off: the row
    -- still drives their own unread badge, but is never shown to anyone else.
    CREATE TABLE IF NOT EXISTS reads (
      convo_id  TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      at        INTEGER NOT NULL,
      private   INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (convo_id, user_id)
    );

    -- Blocking is stored one-directional but enforced both ways: if either
    -- party has blocked the other, nothing should pass between them.
    CREATE TABLE IF NOT EXISTS blocks (
      user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      blocked_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at  INTEGER NOT NULL,
      PRIMARY KEY (user_id, blocked_id)
    );
    CREATE INDEX IF NOT EXISTS idx_blocks_blocked ON blocks(blocked_id);

    CREATE TABLE IF NOT EXISTS reports (
      id           TEXT PRIMARY KEY,
      reporter_id  TEXT REFERENCES users(id) ON DELETE SET NULL,
      subject_id   TEXT REFERENCES users(id) ON DELETE SET NULL,
      convo_id     TEXT,
      message_id   TEXT,
      -- Kept verbatim: the message may be edited or deleted after the report,
      -- and a report about vanished evidence is not much use.
      message_text TEXT,
      reason       TEXT NOT NULL,
      note         TEXT,
      status       TEXT NOT NULL DEFAULT 'open',
      created_at   INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status, created_at);

    CREATE TABLE IF NOT EXISTS contacts (
      user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      contact_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      PRIMARY KEY (user_id, contact_id)
    );

    CREATE TABLE IF NOT EXISTS convo_meta (
      user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      convo_id       TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      pinned         INTEGER NOT NULL DEFAULT 0,
      muted          INTEGER NOT NULL DEFAULT 0,
      draft          TEXT NOT NULL DEFAULT '',
      cleared_before INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, convo_id)
    );

    CREATE TABLE IF NOT EXISTS settings (
      user_id  TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      json     TEXT NOT NULL
    );

    -- Small server-side key/value store: the VAPID identity lives here so a
    -- fresh install needs no configuration and keeps the same keys across
    -- restarts. Rotating them would invalidate every push subscription.
    CREATE TABLE IF NOT EXISTS config (
      key    TEXT PRIMARY KEY,
      value  TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS push_subscriptions (
      endpoint    TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      p256dh      TEXT NOT NULL,
      auth        TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      failures    INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_push_user ON push_subscriptions(user_id);

    -- The cross-worker event bus.
    --
    -- Several worker processes serve the same app (Passenger runs a pool), and
    -- each has its own memory, so an in-process fan-out only ever reaches the
    -- clients that worker happens to hold. Events are appended here instead:
    -- every worker tails the table and delivers to its own streams. The
    -- AUTOINCREMENT id is globally unique and monotonic, which is also what
    -- makes an SSE Last-Event-ID resume correct.
    CREATE TABLE IF NOT EXISTS events (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      type      TEXT NOT NULL,
      data      TEXT NOT NULL,
      audience  TEXT NOT NULL,
      at        INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_events_at ON events(at);

    -- Rate limits must be shared too: held per process, every limit is
    -- silently multiplied by the number of workers.
    CREATE TABLE IF NOT EXISTS rate_limits (
      key           TEXT PRIMARY KEY,
      window_start  INTEGER NOT NULL,
      count         INTEGER NOT NULL
    );

    -- Monotonic counter so clients can resume an SSE stream from a known point.
    CREATE TABLE IF NOT EXISTS counters (
      name   TEXT PRIMARY KEY,
      value  INTEGER NOT NULL
    );
    INSERT OR IGNORE INTO counters(name, value) VALUES ('seq', 0);
  `);

  // CREATE TABLE IF NOT EXISTS does nothing to a table that already exists, so
  // columns added after the first release need their own step.
  addColumns('messages', { system: 'INTEGER NOT NULL DEFAULT 0' });
  addColumns('users', { is_admin: 'INTEGER NOT NULL DEFAULT 0' });
  addColumns('users', {
    pronouns: 'TEXT',
    title: 'TEXT',
    bio: 'TEXT',
    status_emoji: 'TEXT',
    status_text: 'TEXT',
    status_until: 'INTEGER',
    timezone: 'TEXT',
    updated_at: 'INTEGER',
  });
}

/** Add any of `columns` that the table does not already have. */
function addColumns(table, columns) {
  const present = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
  for (const [name, type] of Object.entries(columns)) {
    if (!present.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
  }
}

/** Next global sequence number. Callers must already be inside a transaction
    when they need the seq to line up with the row they are writing. */
export function nextSeq() {
  db.prepare('UPDATE counters SET value = value + 1 WHERE name = ?').run('seq');
  return db.prepare('SELECT value FROM counters WHERE name = ?').get('seq').value;
}

export function currentSeq() {
  return db.prepare("SELECT value FROM counters WHERE name = 'seq'").get().value;
}

/** Run fn inside an IMMEDIATE transaction, rolling back if it throws. */
export function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw err;
  }
}

/* ---------- shaping ---------- */

/** Public view of a user — never leaks password or PIN material. */
export function publicUser(row) {
  if (!row) return null;
  // A status is allowed to expire on its own, so a stale one is simply not
  // reported rather than needing a sweep.
  const statusLive = !row.status_until || row.status_until > Date.now();
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    avatarColor: row.avatar_color,
    isGuest: !!row.is_guest,
    isBot: !!row.is_bot,
    retired: !!row.retired,
    createdAt: row.created_at,
    lastSeen: row.last_seen,
    hasPin: !!row.pin_hash,
    isAdmin: !!row.is_admin,
    pronouns: row.pronouns || null,
    title: row.title || null,
    bio: row.bio || null,
    timezone: row.timezone || null,
    statusEmoji: statusLive ? (row.status_emoji || null) : null,
    statusText: statusLive ? (row.status_text || null) : null,
    statusUntil: statusLive ? (row.status_until || null) : null,
  };
}

export function shapeMessage(row, reactions = {}) {
  return {
    id: row.id,
    convoId: row.convo_id,
    from: row.from_id,
    text: row.deleted_at ? '' : row.text,
    at: row.at,
    seq: row.seq,
    replyTo: row.reply_to || undefined,
    editedAt: row.edited_at || undefined,
    deletedAt: row.deleted_at || undefined,
    deliveredAt: row.delivered_at || undefined,
    system: !!row.system,
    reactions,
  };
}

export function shapeConvo(row, members) {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    createdAt: row.created_at,
    members,
  };
}

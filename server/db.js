// db.js — SQLite persistence via Node's built-in node:sqlite. No ORM, no deps.
// Every query is a prepared statement; nothing is string-concatenated.

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { USERNAME_MAX, slugifyUsername, usernameProblem } from './username.js';

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

/** Idempotent: every step is CREATE IF NOT EXISTS, a guarded ALTER, or a
    backfill that only touches rows still missing the value. */
export function migrate() {
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

    -- Feedback from the Send feedback item in the account menu. author_name is
    -- a snapshot: the point of feedback is that someone can act on it later,
    -- which a deleted account should not erase, so the row survives with
    -- author_id nulled and the name intact.
    CREATE TABLE IF NOT EXISTS feedback (
      id           TEXT PRIMARY KEY,
      author_id    TEXT REFERENCES users(id) ON DELETE SET NULL,
      author_name  TEXT,
      kind         TEXT NOT NULL,
      message      TEXT NOT NULL,
      status       TEXT NOT NULL DEFAULT 'new',
      created_at   INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_feedback_status ON feedback(status, created_at DESC);

    -- One appeal per suspension. A suspended account cannot sign in, so this is
    -- the only thing it can write, and the PRIMARY KEY on (user_id,
    -- suspended_at) is what makes it *one*: a second attempt against the same
    -- suspension replaces nothing and inserts nothing.
    CREATE TABLE IF NOT EXISTS appeals (
      user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      suspended_at  INTEGER NOT NULL,
      message       TEXT NOT NULL,
      status        TEXT NOT NULL DEFAULT 'new',
      created_at    INTEGER NOT NULL,
      PRIMARY KEY (user_id, suspended_at)
    );

    -- Everything an administrator does, and every time one opens the dashboard.
    -- Append-only by convention: nothing in the app updates or deletes a row
    -- here, because a moderation record you can quietly revise is not a record.
    -- actor_id does not cascade: if the account is deleted the trail must remain.
    CREATE TABLE IF NOT EXISTS admin_audit (
      id           TEXT PRIMARY KEY,
      actor_id     TEXT,
      actor_name   TEXT,
      action       TEXT NOT NULL,
      target_type  TEXT,
      target_id    TEXT,
      detail       TEXT,
      ip           TEXT,
      at           INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_audit_at ON admin_audit(at DESC);

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

  // Suspension. `suspended_until` NULL alongside a non-null `suspended_at`
  // means indefinite; a timestamp means it lapses on its own, which is what
  // makes a cooling-off period possible without anyone remembering to undo it.
  addColumns('users', {
    suspended_at: 'INTEGER',
    suspended_until: 'INTEGER',
    suspended_reason: 'TEXT',
    suspended_by: 'TEXT',
  });

  // SQLite cannot add a UNIQUE column, so the constraint is a separate index.
  // NULLs do not collide in a SQLite unique index, which is what lets the
  // column exist for a moment before the backfill fills it in.
  addColumns('users', { username: 'TEXT' });
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username)');
  backfillUsernames();
}

/**
 * Give every account that predates usernames one.
 *
 * A handle is only useful if you can rely on everyone having it, so this runs
 * over the existing rows rather than leaving a mix of accounts with and
 * without. Derived from the display name, with a numeric suffix when that is
 * taken; a name that survives slugification as nothing (all emoji, all
 * punctuation, a script this cannot fold) falls back to `user_<n>`.
 */
function backfillUsernames() {
  const rows = db.prepare('SELECT id, name FROM users WHERE username IS NULL').all();
  if (!rows.length) return;
  const taken = new Set(
    db.prepare('SELECT username FROM users WHERE username IS NOT NULL').all().map((r) => r.username),
  );
  const set = db.prepare('UPDATE users SET username = ? WHERE id = ?');
  for (const row of rows) {
    const name = allocateUsername(slugifyUsername(row.name), taken);
    taken.add(name);
    set.run(name, row.id);
  }
}

/**
 * The first free handle at or after `stem`.
 *
 * `taken` is the caller's view of what exists. It is only a fast path: the
 * unique index is what actually guarantees no two accounts share a handle,
 * because two workers can allocate at the same moment.
 */
export function allocateUsername(stem, taken = new Set()) {
  let base = String(stem || '').slice(0, USERNAME_MAX - 3);
  if (!base || usernameProblem(base)) base = 'user';
  if (!taken.has(base) && !isTakenInDb(base)) return base;
  for (let n = 2; n < 100000; n++) {
    const candidate = `${base}_${n}`.slice(0, USERNAME_MAX);
    if (!taken.has(candidate) && !isTakenInDb(candidate)) return candidate;
  }
  throw new Error('Could not allocate a username.');
}

function isTakenInDb(name) {
  return !!db.prepare('SELECT 1 AS ok FROM users WHERE username = ?').get(name);
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
    username: row.username || null,
    email: row.email,
    role: row.role,
    avatarColor: row.avatar_color,
    isGuest: !!row.is_guest,
    isBot: !!row.is_bot,
    retired: !!row.retired,
    createdAt: row.created_at,
    lastSeen: row.last_seen,
    hasPin: !!row.pin_hash,
    // is_admin is deliberately absent. This shape goes out in search results,
    // profile cards and conversation member lists, so including it would hand
    // every user a list of which accounts are worth attacking. The flag is
    // reported only on the self view, by selfUser below.
    pronouns: row.pronouns || null,
    title: row.title || null,
    bio: row.bio || null,
    timezone: row.timezone || null,
    statusEmoji: statusLive ? (row.status_emoji || null) : null,
    statusText: statusLive ? (row.status_text || null) : null,
    statusUntil: statusLive ? (row.status_until || null) : null,
  };
}

/**
 * Whether this account is suspended right now.
 *
 * A temporary suspension is not swept by a job — it is simply not in force once
 * its end time has passed, the same way an expired status is not reported. That
 * means the state is always computed from the row rather than depending on a
 * timer having run, so a server that was switched off over the weekend does not
 * hold somebody out longer than they were told.
 */
export function suspensionOf(row) {
  if (!row?.suspended_at) return null;
  if (row.suspended_until && row.suspended_until <= Date.now()) return null;
  return {
    at: row.suspended_at,
    until: row.suspended_until || null,
    reason: row.suspended_reason || null,
  };
}

export const isSuspended = (row) => !!suspensionOf(row);

/**
 * What an account is told about itself.
 *
 * The only place `isAdmin` appears, and it is a hint for the client's own UI —
 * nothing is authorised by it. Every admin route re-reads the flag from the
 * database, so a tampered response buys an attacker a menu item and no access.
 */
export function selfUser(row) {
  if (!row) return null;
  return { ...publicUser(row), isAdmin: !!row.is_admin };
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

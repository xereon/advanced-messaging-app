// auth.js — real server-side authentication.
//
// Passwords and PINs are hashed with scrypt and a per-record random salt.
// Session tokens are random 256-bit values; only their SHA-256 digest is
// stored, so a database leak does not hand out live sessions. Comparisons go
// through timingSafeEqual.

import {
  randomBytes, scrypt as scryptCb, timingSafeEqual, createHash, randomUUID,
} from 'node:crypto';
import { promisify } from 'node:util';
import { handle, tx, publicUser } from './db.js';

const scrypt = promisify(scryptCb);

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;   // 30 days
const GUEST_TTL_MS = 24 * 60 * 60 * 1000;          // 1 day
const CODE_TTL_MS = 10 * 60 * 1000;                // 10 minutes
const MAX_CODE_ATTEMPTS = 5;

export const SESSION_COOKIE = 'relay_session';

export function uid(prefix) { return `${prefix}-${randomUUID()}`; }

/* ---------- hashing ---------- */

async function hash(secret, saltHex) {
  const buf = await scrypt(String(secret), saltHex, SCRYPT.keylen, {
    N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p,
    maxmem: 64 * 1024 * 1024,
  });
  return buf.toString('hex');
}

export async function makeSecret(secret) {
  const salt = randomBytes(16).toString('hex');
  return { salt, hash: await hash(secret, salt) };
}

export async function verifySecret(secret, salt, expectedHex) {
  if (!salt || !expectedHex) return false;
  const actual = Buffer.from(await hash(secret, salt), 'hex');
  const expected = Buffer.from(expectedHex, 'hex');
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

/* ---------- sessions ---------- */

const tokenDigest = (token) => createHash('sha256').update(token).digest('hex');

export function createSession(userId, method, { ttlMs = SESSION_TTL_MS } = {}) {
  const token = randomBytes(32).toString('base64url');
  const now = Date.now();
  handle().prepare(
    'INSERT INTO sessions (token_hash, user_id, method, created_at, expires_at) VALUES (?,?,?,?,?)',
  ).run(tokenDigest(token), userId, method, now, now + ttlMs);
  return { token, expiresAt: now + ttlMs };
}

export function sessionUser(token) {
  if (!token) return null;
  const db = handle();
  const row = db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(tokenDigest(token));
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(row.token_hash);
    return null;
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(row.user_id);
  return user ? { user, method: row.method } : null;
}

export function destroySession(token) {
  if (!token) return;
  handle().prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenDigest(token));
}

export function destroyAllSessions(userId) {
  handle().prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

export function pruneExpiredSessions() {
  handle().prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
}

export function cookieHeader(token, expiresAt, secure) {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Expires=${new Date(expiresAt).toUTCString()}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function clearCookieHeader() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

/* ---------- accounts ---------- */

const AVATAR_COLORS = ['#2458E6', '#7C4DDB', '#B0367A', '#0E7490', '#B45309', '#4D7C0F', '#334155', '#9D174D'];
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

export const normalizeEmail = (email) => String(email || '').trim().toLowerCase();

export function findByEmail(email) {
  return handle().prepare('SELECT * FROM users WHERE email = ?').get(normalizeEmail(email)) || null;
}

export function findById(id) {
  return handle().prepare('SELECT * FROM users WHERE id = ?').get(id) || null;
}

export async function createAccount({ name, email, password }) {
  const db = handle();
  const clean = normalizeEmail(email);
  if (findByEmail(clean)) {
    const err = new Error('An account with that email already exists.');
    err.status = 409;
    throw err;
  }
  const { salt, hash: pwHash } = await makeSecret(password);
  const user = {
    id: uid('u'),
    name: String(name).trim().slice(0, 60),
    email: clean,
    avatar_color: pick(AVATAR_COLORS),
    created_at: Date.now(),
  };
  db.prepare(`INSERT INTO users (id, name, email, pw_hash, pw_salt, avatar_color, created_at, last_seen)
              VALUES (?,?,?,?,?,?,?,0)`)
    .run(user.id, user.name, user.email, pwHash, salt, user.avatar_color, user.created_at);
  return findById(user.id);
}

const GUEST_NAMES = [
  'Visiting Falcon', 'Curious Otter', 'Quiet Heron', 'Bold Lynx', 'Swift Ibis',
  'Calm Marten', 'Keen Osprey', 'Bright Vixen', 'Steady Badger', 'Nimble Kestrel',
];
const GUEST_COLORS = ['#334155', '#0E7490', '#4D7C0F', '#7C4DDB', '#B45309', '#B0367A'];

export function createGuest() {
  const db = handle();
  const taken = new Set(
    db.prepare('SELECT name FROM users WHERE is_guest = 1 AND retired = 0').all().map((r) => r.name),
  );
  let name = GUEST_NAMES.find((n) => !taken.has(n));
  if (!name) {
    let n = 2;
    while (taken.has(`${GUEST_NAMES[0]} ${n}`)) n++;
    name = `${GUEST_NAMES[0]} ${n}`;
  }
  const usedColors = new Set(
    db.prepare('SELECT avatar_color FROM users WHERE is_guest = 1 AND retired = 0').all().map((r) => r.avatar_color),
  );
  const id = uid('u');
  db.prepare(`INSERT INTO users (id, name, email, avatar_color, role, is_guest, created_at, last_seen)
              VALUES (?,?,NULL,?,'Guest',1,?,0)`)
    .run(id, name, GUEST_COLORS.find((c) => !usedColors.has(c)) || pick(GUEST_COLORS), Date.now());
  return findById(id);
}

export { GUEST_TTL_MS, SESSION_TTL_MS, publicUser };

/* ---------- one-time login codes ---------- */

export async function issueLoginCode(email) {
  const clean = normalizeEmail(email);
  const user = findByEmail(clean);
  if (!user) {
    const err = new Error('No account found for that email.');
    err.status = 404;
    throw err;
  }
  const code = String(randomBytes(4).readUInt32BE(0) % 1000000).padStart(6, '0');
  const { salt, hash: codeHash } = await makeSecret(code);
  handle().prepare(
    `INSERT INTO login_codes (email, code_hash, expires_at, attempts) VALUES (?,?,?,0)
     ON CONFLICT(email) DO UPDATE SET code_hash = excluded.code_hash,
       expires_at = excluded.expires_at, attempts = 0`,
  ).run(clean, `${salt}:${codeHash}`, Date.now() + CODE_TTL_MS);
  return { code, user };
}

export async function redeemLoginCode(email, code) {
  const db = handle();
  const clean = normalizeEmail(email);
  const row = db.prepare('SELECT * FROM login_codes WHERE email = ?').get(clean);
  const fail = (msg, status = 400) => { const e = new Error(msg); e.status = status; throw e; };
  if (!row) fail('Request a code first.');
  if (row.expires_at < Date.now()) {
    db.prepare('DELETE FROM login_codes WHERE email = ?').run(clean);
    fail('That code expired. Request a new one.');
  }
  if (row.attempts >= MAX_CODE_ATTEMPTS) {
    db.prepare('DELETE FROM login_codes WHERE email = ?').run(clean);
    fail('Too many incorrect attempts. Request a new code.', 429);
  }
  const [salt, expected] = row.code_hash.split(':');
  if (!(await verifySecret(String(code).trim(), salt, expected))) {
    db.prepare('UPDATE login_codes SET attempts = attempts + 1 WHERE email = ?').run(clean);
    fail('That code is not right.');
  }
  db.prepare('DELETE FROM login_codes WHERE email = ?').run(clean);
  return findByEmail(clean);
}

/* ---------- password reset ---------- */

/**
 * Issue a reset code. Deliberately silent about whether the address exists —
 * the caller reports the same thing either way, so this endpoint cannot be
 * used to discover who has an account.
 */
export async function issueResetCode(email) {
  const clean = normalizeEmail(email);
  const user = findByEmail(clean);
  if (!user || !user.pw_hash) return { code: null, user: null };

  const code = String(randomBytes(4).readUInt32BE(0) % 1000000).padStart(6, '0');
  const { salt, hash } = await makeSecret(code);
  handle().prepare(
    `INSERT INTO reset_codes (email, code_hash, expires_at, attempts) VALUES (?,?,?,0)
     ON CONFLICT(email) DO UPDATE SET code_hash = excluded.code_hash,
       expires_at = excluded.expires_at, attempts = 0`,
  ).run(clean, `${salt}:${hash}`, Date.now() + CODE_TTL_MS);
  return { code, user };
}

export async function redeemResetCode(email, code, newPassword) {
  const db = handle();
  const clean = normalizeEmail(email);
  const row = db.prepare('SELECT * FROM reset_codes WHERE email = ?').get(clean);
  const fail = (msg, status = 400) => { const e = new Error(msg); e.status = status; throw e; };

  if (!row) fail('Request a reset code first.');
  if (row.expires_at < Date.now()) {
    db.prepare('DELETE FROM reset_codes WHERE email = ?').run(clean);
    fail('That code expired. Request a new one.');
  }
  if (row.attempts >= MAX_CODE_ATTEMPTS) {
    db.prepare('DELETE FROM reset_codes WHERE email = ?').run(clean);
    fail('Too many incorrect attempts. Request a new code.', 429);
  }
  if (String(newPassword || '').length < 8) fail('Password must be at least 8 characters.');

  const [salt, expected] = row.code_hash.split(':');
  if (!(await verifySecret(String(code).trim(), salt, expected))) {
    db.prepare('UPDATE reset_codes SET attempts = attempts + 1 WHERE email = ?').run(clean);
    fail('That code is not right.');
  }

  const user = findByEmail(clean);
  const next = await makeSecret(newPassword);
  db.prepare('UPDATE users SET pw_hash = ?, pw_salt = ? WHERE id = ?').run(next.hash, next.salt, user.id);
  db.prepare('DELETE FROM reset_codes WHERE email = ?').run(clean);
  // Whoever was signed in with the old password no longer is.
  destroyAllSessions(user.id);
  return findById(user.id);
}

/* ---------- WebAuthn credential storage ---------- */

const CHALLENGE_TTL_MS = 5 * 60 * 1000;

export function storeChallenge(challenge, purpose, userId = null) {
  handle().prepare(
    'INSERT INTO webauthn_challenges (challenge, user_id, purpose, expires_at) VALUES (?,?,?,?)',
  ).run(challenge, userId, purpose, Date.now() + CHALLENGE_TTL_MS);
}

/** Challenges are single-use: taking one deletes it. */
export function takeChallenge(challenge, purpose) {
  const db = handle();
  db.prepare('DELETE FROM webauthn_challenges WHERE expires_at < ?').run(Date.now());
  const row = db.prepare(
    'SELECT * FROM webauthn_challenges WHERE challenge = ? AND purpose = ?',
  ).get(String(challenge || ''), purpose);
  if (!row) return null;
  db.prepare('DELETE FROM webauthn_challenges WHERE challenge = ?').run(row.challenge);
  return row.expires_at < Date.now() ? null : row;
}

export function saveCredential(userId, cred, label) {
  handle().prepare(
    `INSERT INTO credentials (credential_id, user_id, public_key, alg, sign_count, label, created_at)
     VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(credential_id) DO UPDATE SET public_key = excluded.public_key,
       alg = excluded.alg, sign_count = excluded.sign_count`,
  ).run(cred.credentialId, userId, cred.publicKey, cred.alg, cred.signCount, label || null, Date.now());
}

export function credentialsOf(userId) {
  return handle().prepare('SELECT * FROM credentials WHERE user_id = ? ORDER BY created_at').all(userId);
}

export function findCredential(credentialId) {
  return handle().prepare('SELECT * FROM credentials WHERE credential_id = ?').get(String(credentialId || '')) || null;
}

export function touchCredential(credentialId, signCount) {
  handle().prepare('UPDATE credentials SET sign_count = ?, last_used_at = ? WHERE credential_id = ?')
    .run(signCount, Date.now(), credentialId);
}

export function deleteCredential(userId, credentialId) {
  handle().prepare('DELETE FROM credentials WHERE user_id = ? AND credential_id = ?').run(userId, credentialId);
}

/* ---------- rate limiting ---------- */

let limitsEnabled = process.env.RELAY_RATE_LIMIT !== 'off';

/**
 * Fixed-window limiter, shared across workers. Returns true when allowed.
 *
 * Counting in process memory silently multiplies every limit by the size of
 * the worker pool: with four workers, an "8 attempts" cap really allows 32.
 * The counter therefore lives in the database, where all workers share it.
 */
export function rateLimit(key, { limit, windowMs }) {
  if (!limitsEnabled) return true;
  const now = Date.now();
  const db = handle();

  try {
    return tx(() => {
      const row = db.prepare('SELECT window_start, count FROM rate_limits WHERE key = ?').get(key);
      if (!row || now - row.window_start >= windowMs) {
        db.prepare(
          `INSERT INTO rate_limits (key, window_start, count) VALUES (?,?,1)
           ON CONFLICT(key) DO UPDATE SET window_start = excluded.window_start, count = 1`,
        ).run(key, now);
        return true;
      }
      const next = row.count + 1;
      db.prepare('UPDATE rate_limits SET count = ? WHERE key = ?').run(next, key);
      return next <= limit;
    });
  } catch {
    // A limiter that cannot read its own state must not lock everybody out.
    return true;
  }
}

export function resetRateLimits() {
  try { handle().prepare('DELETE FROM rate_limits').run(); } catch { /* not open */ }
}

/** Tests flip this to exercise both the limited and unlimited paths. */
export function setRateLimitEnabled(value) {
  limitsEnabled = !!value;
  if (!value) resetRateLimits();
}

export function pruneRateLimits(olderThanMs = 60 * 60 * 1000) {
  try {
    handle().prepare('DELETE FROM rate_limits WHERE window_start < ?').run(Date.now() - olderThanMs);
  } catch { /* not open */ }
}

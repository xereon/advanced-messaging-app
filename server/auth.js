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
import { handle, publicUser } from './db.js';

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

/* ---------- rate limiting ---------- */

const buckets = new Map();
let limitsEnabled = process.env.RELAY_RATE_LIMIT !== 'off';

/** Fixed-window limiter. Returns true when the call is allowed. */
export function rateLimit(key, { limit, windowMs }) {
  if (!limitsEnabled) return true;
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || now > b.reset) {
    buckets.set(key, { count: 1, reset: now + windowMs });
    return true;
  }
  b.count += 1;
  return b.count <= limit;
}

export function resetRateLimits() { buckets.clear(); }

/** Tests flip this to exercise both the limited and unlimited paths. */
export function setRateLimitEnabled(value) {
  limitsEnabled = !!value;
  if (!value) buckets.clear();
}

// Keep the bucket map from growing without bound in a long-lived process.
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) if (now > b.reset) buckets.delete(k);
}, 60_000).unref?.();

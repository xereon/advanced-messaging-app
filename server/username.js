// username.js — the rules for a handle.
//
// Its own module because both the schema migration (which backfills every
// existing account) and the request layer (which validates what people type)
// need these, and db.js cannot import auth.js without a cycle.
//
// Usernames are stored already lowercased. Case is not identity here: letting
// `Ben` and `ben` both exist would make a handle useless for finding somebody,
// and would be an obvious impersonation route.

export const USERNAME_MIN = 3;
export const USERNAME_MAX = 20;
export const USERNAME_RE = /^[a-z0-9_]{3,20}$/;

/**
 * Handles that must not be claimed by an ordinary account.
 *
 * Everything here either addresses the service itself or would let someone
 * pass as staff. `me` and `everyone` are held back for mentions.
 */
const RESERVED = new Set([
  'admin', 'administrator', 'root', 'relay', 'system', 'support', 'help',
  'security', 'abuse', 'moderator', 'mod', 'staff', 'official', 'team',
  'billing', 'noreply', 'no_reply', 'postmaster', 'webmaster', 'api',
  'me', 'you', 'everyone', 'here', 'all', 'null', 'undefined', 'guest',
]);

export const isReserved = (name) => RESERVED.has(String(name || '').toLowerCase());

/** Canonical form: lowercase, trimmed, with a leading @ ignored. */
export function normalizeUsername(input) {
  return String(input ?? '').trim().replace(/^@+/, '').toLowerCase();
}

/**
 * Why a username is not acceptable, or null when it is.
 *
 * Returns the message shown to whoever typed it, so each rule explains itself
 * rather than failing with one generic "invalid".
 */
export function usernameProblem(input) {
  const name = normalizeUsername(input);
  if (!name) return 'Choose a username.';
  if (name.length < USERNAME_MIN) return `Usernames are at least ${USERNAME_MIN} characters.`;
  if (name.length > USERNAME_MAX) return `Usernames are at most ${USERNAME_MAX} characters.`;
  if (!USERNAME_RE.test(name)) return 'Usernames use letters, numbers and underscores only.';
  if (/^[0-9_]+$/.test(name)) return 'Usernames need at least one letter.';
  if (isReserved(name)) return 'That username is reserved.';
  return null;
}

/**
 * A starting handle derived from a display name.
 *
 * Accent-folded so "Zoë Ferreira" becomes `zoe_ferreira` rather than losing the
 * character. Whatever survives may still be too short or entirely reserved, so
 * the caller has to make it unique and this only has to produce a stem.
 */
export function slugifyUsername(displayName) {
  const base = String(displayName || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')   // strip the combining marks NFKD split out
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, USERNAME_MAX);
  return /[a-z]/.test(base) ? base : '';
}

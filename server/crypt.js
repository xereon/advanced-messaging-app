// crypt.js — optional encryption at rest for user-written text.
//
// **What this defends against, precisely.** Someone who obtains the database
// file but not the server: a copied backup, a misconfigured document root
// serving `data/relay.db` (a real risk this project's own cPanel notes warn
// about), a decommissioned disk. With a key it cannot read, that file is inert.
//
// **What it does not defend against.** Anyone who can run code on the server, or
// read its environment, has the key by definition. This is not end-to-end
// encryption and does not pretend to be: the server decrypts in order to render
// and to search, so a compromised host reads everything. Encrypting at rest is
// worth doing anyway — the file leaking is a far more common accident than the
// host falling — but claiming more than that would be a lie.
//
// **Why it is opt-in.** Turning it on without a key backup loses every message.
// A default-on scheme whose key lives beside the data protects against nothing
// while making that failure mode universal, so the operator has to choose it,
// and `npm run encrypt` tells them what they are choosing.

import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';

// A version marker, so a database can hold both forms at once. That is what
// makes the migration restartable and a half-converted database readable
// instead of half-broken — existing plaintext rows are recognised as plaintext
// and left alone.
//
// It starts with a control character deliberately. A printable marker was
// ambiguous: somebody typing a message that began with it had their message
// stored unencrypted and then read back as undecryptable, because the guard
// could not tell a stored ciphertext from text that merely looked like one.
// Every text input strips control characters, so U+0001 is a marker no user can
// forge.
//
// Not NUL, which would have been the obvious pick: node:sqlite truncates a
// string at the first NUL, so a NUL-prefixed value reads back as empty — every
// message lost. U+0001 round-trips intact.
const PREFIX = '\u0001enc1.';

/** Exported so callers do not hardcode it and drift from the real value. */
export const MARKER = PREFIX;
const IV_BYTES = 12;    // GCM standard
const TAG_BYTES = 16;

let key = null;

/**
 * Read the key from the environment. Accepts base64 or hex; must be 32 bytes.
 *
 * Throws rather than falling back to plaintext. Starting unencrypted because a
 * key was a character short is the one outcome nobody wants: it would look like
 * it was working.
 */
export function configure(raw = process.env.RELAY_ENCRYPTION_KEY) {
  if (!raw) { key = null; return false; }
  const text = String(raw).trim();
  let buf = null;
  if (/^[0-9a-fA-F]{64}$/.test(text)) buf = Buffer.from(text, 'hex');
  else {
    try { buf = Buffer.from(text, 'base64'); } catch { buf = null; }
  }
  if (!buf || buf.length !== 32) {
    throw new Error(
      'RELAY_ENCRYPTION_KEY must be 32 bytes, as 64 hex characters or base64.'
      + ' Generate one with:  node -e "console.log(require(\'node:crypto\').randomBytes(32).toString(\'base64\'))"',
    );
  }
  key = buf;
  return true;
}

export const isEnabled = () => key !== null;

/** For tests and the migration script, which need to set a key directly. */
export function setKey(buf) { key = buf; }

/** Is this stored value encrypted? Answered from the value, not from config. */
export const isSealed = (value) => typeof value === 'string' && value.startsWith(PREFIX);

/**
 * Encrypt for storage, or pass through when no key is configured.
 *
 * null and the empty string are returned untouched: a deleted message stores an
 * empty body, and encrypting nothing would turn "no text" into a value that
 * looks like text.
 */
export function seal(plaintext) {
  if (!key || plaintext === null || plaintext === undefined || plaintext === '') return plaintext;
  // Already sealed. Only the migration can produce this, because it is the only
  // caller that passes stored values back in; user text cannot reach here
  // carrying the marker.
  if (isSealed(plaintext)) return plaintext;
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
}

/**
 * Decrypt a stored value, passing plaintext through unchanged.
 *
 * A value that is sealed but cannot be opened returns a placeholder rather than
 * throwing. One unreadable row — a rotated key, a restore from the wrong
 * backup — should not take down the conversation around it, and the placeholder
 * makes the problem visible instead of silently blank.
 */
export function open(stored) {
  if (!isSealed(stored)) return stored;
  if (!key) return '[encrypted — no key configured]';
  try {
    const raw = Buffer.from(stored.slice(PREFIX.length), 'base64');
    const iv = raw.subarray(0, IV_BYTES);
    const tag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return decipher.update(raw.subarray(IV_BYTES + TAG_BYTES), undefined, 'utf8') + decipher.final('utf8');
  } catch {
    return '[could not be decrypted]';
  }
}

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

import { randomBytes, createCipheriv, createDecipheriv, createHmac } from 'node:crypto';

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

/* ---------- files on disk ---------- */

// Uploaded files get a magic header instead of the text marker, because a file
// is bytes rather than a string and there is nothing to strip control characters
// from. Same shape otherwise: a version tag, then IV, tag and ciphertext.
const FILE_MAGIC = Buffer.from('RELAYENC1');

/** Does this file begin with our header? Answered from the bytes, as with text. */
export const isSealedFile = (head) =>
  Buffer.isBuffer(head) && head.length >= FILE_MAGIC.length && head.subarray(0, FILE_MAGIC.length).equals(FILE_MAGIC);

export const FILE_HEADER_BYTES = FILE_MAGIC.length + IV_BYTES + TAG_BYTES;

/**
 * Encrypt a whole file's bytes.
 *
 * Whole-file rather than streaming, deliberately. GCM only authenticates at the
 * very end, so a streaming decrypt has to emit plaintext before it knows the
 * bytes are genuine — fine for a huge archive, wrong for something served into a
 * browser. Uploads are capped at 10 MB, so buffering is affordable and lets the
 * tag be checked before a single byte reaches the client.
 */
export function sealBytes(buf) {
  if (!key) return buf;
  if (isSealedFile(buf)) return buf;
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(buf), cipher.final()]);
  return Buffer.concat([FILE_MAGIC, iv, cipher.getAuthTag(), body]);
}

/**
 * Decrypt a file's bytes, passing an unencrypted file through untouched.
 *
 * Throws rather than returning a placeholder: half an image is not a degraded
 * image, it is a broken download, and the caller needs to answer with an error
 * status instead of serving nonsense.
 */
export function openBytes(buf) {
  if (!isSealedFile(buf)) return buf;
  if (!key) {
    const err = new Error('This file is encrypted and no key is configured.');
    err.status = 500;
    throw err;
  }
  const iv = buf.subarray(FILE_MAGIC.length, FILE_MAGIC.length + IV_BYTES);
  const tag = buf.subarray(FILE_MAGIC.length + IV_BYTES, FILE_HEADER_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(buf.subarray(FILE_HEADER_BYTES)), decipher.final()]);
}

/* ---------- deterministic lookup ---------- */

/**
 * A keyed hash of a value, for columns that have to be *found* rather than read.
 *
 * An email address is the case that forces this. Encrypting it gives a different
 * ciphertext every time, so `WHERE email = ?` can never match and the UNIQUE
 * constraint stops preventing duplicates. A keyed hash is stable, so it can be
 * indexed, matched and made unique — while still telling somebody holding the
 * database file nothing, because reversing it needs the key.
 *
 * Deliberately not a bare SHA-256: the space of real email addresses is small
 * enough to enumerate, so an unkeyed digest of one is barely a secret at all.
 */
export function lookupHash(value) {
  if (!key || value === null || value === undefined || value === '') return null;
  return createHmac('sha256', key).update(String(value)).digest('hex');
}

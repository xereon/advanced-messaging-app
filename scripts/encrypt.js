#!/usr/bin/env node
// encrypt.js — turn encryption at rest on for an existing database, or off again.
//
//   npm run encrypt -- --key            generate a key to put in the environment
//   RELAY_ENCRYPTION_KEY=… npm run encrypt          encrypt everything not yet encrypted
//   RELAY_ENCRYPTION_KEY=… npm run encrypt -- --off decrypt everything back to plaintext
//   RELAY_ENCRYPTION_KEY=… npm run encrypt -- --status   count what is stored which way
//
// Safe to interrupt and re-run. Each value carries its own marker, so the script
// only touches what is still in the other form and a half-finished run leaves a
// database the server can read either way.
//
// Stop the server first. It is not required for correctness — SQLite's WAL and
// the per-value marker handle concurrent reads — but a message written during
// the run lands in whichever form the server has configured, and that is easier
// to reason about if nothing is writing.

import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

import * as db from '../server/db.js';
import * as crypt from '../server/crypt.js';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const DB_FILE = process.env.RELAY_DB || join(ROOT, 'data', 'relay.db');
const args = process.argv.slice(2);
const has = (flag) => args.includes(`--${flag}`);

if (has('key')) {
  console.log('\nAdd this to the server environment, and keep a copy somewhere safe:\n');
  console.log(`  RELAY_ENCRYPTION_KEY=${randomBytes(32).toString('base64')}\n`);
  console.log('Then run:  npm run encrypt\n');
  console.log('If you lose this key, every encrypted message is unrecoverable.');
  console.log('There is no recovery path, by design — that is what makes the');
  console.log('database file useless to somebody who copies it.\n');
  process.exit(0);
}

// Every column holding something personal. Names and usernames are deliberately
// absent: both are matched by prefix in people search, which ciphertext cannot
// support, and both are already visible to any signed-in account — so encrypting
// them would cost a working feature to protect something the app shows anyway.
const COLUMNS = [
  { table: 'messages', column: 'text', key: 'id' },
  { table: 'reports', column: 'message_text', key: 'id' },
  { table: 'reports', column: 'note', key: 'id' },
  { table: 'feedback', column: 'message', key: 'id' },
  { table: 'convo_meta', column: 'draft', key: 'rowid' },
  { table: 'appeals', column: 'message', key: 'rowid' },
  { table: 'users', column: 'bio', key: 'id' },
  { table: 'users', column: 'status_text', key: 'id' },
  { table: 'users', column: 'pronouns', key: 'id' },
  { table: 'users', column: 'title', key: 'id' },
];

let enabled = false;
try {
  enabled = crypt.configure();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

if (!enabled) {
  console.error('RELAY_ENCRYPTION_KEY is not set.\n');
  console.error('Generate one with:  npm run encrypt -- --key');
  process.exit(1);
}

db.open(DB_FILE);
const handle = db.handle();

/* ---------- status ---------- */

function status() {
  console.log(`Database: ${DB_FILE}\n`);
  let sealed = 0;
  let plain = 0;
  for (const { table, column } of COLUMNS) {
    const rows = handle.prepare(
      `SELECT ${column} AS v FROM ${table} WHERE ${column} IS NOT NULL AND ${column} != ''`,
    ).all();
    const s = rows.filter((r) => crypt.isSealed(r.v)).length;
    sealed += s;
    plain += rows.length - s;
    console.log(`  ${table}.${column}`.padEnd(28) + `${s} encrypted, ${rows.length - s} plaintext`);
  }
  console.log(`\n  ${sealed} encrypted, ${plain} plaintext in total.`);
  return { sealed, plain };
}

if (has('status')) {
  status();
  db.close();
  process.exit(0);
}

/* ---------- convert ---------- */

const off = has('off');
const wanted = off ? 'plaintext' : 'encrypted';
console.log(`Converting ${DB_FILE} to ${wanted}.\n`);

let changed = 0;
for (const { table, column, key } of COLUMNS) {
  const rows = handle.prepare(
    `SELECT ${key} AS k, ${column} AS v FROM ${table} WHERE ${column} IS NOT NULL AND ${column} != ''`,
  ).all();

  const todo = rows.filter((r) => (off ? crypt.isSealed(r.v) : !crypt.isSealed(r.v)));
  if (!todo.length) {
    console.log(`  ${table}.${column}`.padEnd(28) + 'nothing to do');
    continue;
  }

  const update = handle.prepare(`UPDATE ${table} SET ${column} = ? WHERE ${key} = ?`);
  // One transaction per column: an interrupted run leaves whole columns done
  // rather than a torn row, and re-running finishes the rest.
  handle.exec('BEGIN IMMEDIATE');
  try {
    for (const row of todo) {
      const next = off ? crypt.open(row.v) : crypt.seal(row.v);
      // A value that failed to decrypt must never be written back — that would
      // replace the ciphertext with the placeholder and destroy it for good.
      if (off && /^\[(encrypted|could not be decrypted)/.test(next)) {
        throw new Error(
          `Could not decrypt ${table}.${column} for ${row.k}. This is the wrong key —`
          + ' nothing has been changed.',
        );
      }
      update.run(next, row.k);
      changed++;
    }
    handle.exec('COMMIT');
    console.log(`  ${table}.${column}`.padEnd(28) + `${todo.length} converted`);
  } catch (err) {
    handle.exec('ROLLBACK');
    console.error(`\n${err.message}`);
    db.close();
    process.exit(1);
  }
}

/* --- email addresses, which need their lookup hash written alongside --- */

// Handled apart from COLUMNS because an encrypted address is unusable on its
// own: sign-in, password reset and the exact-address directory match all need
// the keyed hash, and the UNIQUE constraint moves onto it.
const emailRows = handle.prepare(
  "SELECT id, email, email_hmac FROM users WHERE email IS NOT NULL AND email != ''",
).all();

const emailsToDo = emailRows.filter((r) => (off ? crypt.isSealed(r.email) : !crypt.isSealed(r.email)));
if (!emailsToDo.length) {
  console.log('  users.email'.padEnd(28) + 'nothing to do');
} else {
  const setEmail = handle.prepare('UPDATE users SET email = ?, email_hmac = ? WHERE id = ?');
  handle.exec('BEGIN IMMEDIATE');
  try {
    for (const row of emailsToDo) {
      if (off) {
        const plain = crypt.open(row.email);
        if (/^\[(encrypted|could not be decrypted)/.test(plain)) {
          throw new Error(`Could not decrypt users.email for ${row.id}. This is the wrong key —`
            + ' nothing has been changed.');
        }
        // The hash goes with it: without a key it means nothing, and leaving it
        // behind would keep a fingerprint of the address in a plaintext database.
        setEmail.run(plain, null, row.id);
      } else {
        setEmail.run(crypt.seal(row.email), crypt.lookupHash(row.email), row.id);
      }
      changed++;
    }
    handle.exec('COMMIT');
    console.log('  users.email'.padEnd(28) + `${emailsToDo.length} converted`);
  } catch (err) {
    handle.exec('ROLLBACK');
    console.error(`\n${err.message}`);
    db.close();
    process.exit(1);
  }
}

// One-time codes are keyed by the address itself. They expire in ten minutes, so
// rather than re-key them, drop them: the worst case is somebody re-requesting a
// code they had just asked for.
const codes = handle.prepare('SELECT COUNT(*) AS n FROM login_codes').get().n
  + handle.prepare('SELECT COUNT(*) AS n FROM reset_codes').get().n;
if (codes) {
  handle.exec('DELETE FROM login_codes; DELETE FROM reset_codes;');
  console.log('  one-time codes'.padEnd(28) + `${codes} cleared (they hold addresses as keys)`);
}

// The cross-worker event bus stores whole published payloads as JSON — a message
// event carries the body, a users event carries an address. New writes are sealed,
// but rows written before the migration are not, so converting the messages table
// while leaving these behind would put the same words back in the file. They are
// transient by design (the bus prunes them, and a reconnecting client resyncs),
// so dropping them is both simpler and more thorough than re-encrypting them.
const events = handle.prepare('SELECT COUNT(*) AS n FROM events').get().n;
if (events) {
  handle.exec('DELETE FROM events');
  console.log('  queued events'.padEnd(28) + `${events} cleared (they hold whole payloads)`);
}

/* --- files on disk --- */

const fileRows = handle.prepare("SELECT path FROM attachments WHERE path IS NOT NULL").all()
  .concat(handle.prepare("SELECT avatar_path AS path FROM users WHERE avatar_path IS NOT NULL").all());

let filesDone = 0;
for (const { path: filePath } of fileRows) {
  try {
    const bytes = readFileSync(filePath);
    const isSealed = crypt.isSealedFile(bytes);
    if (off && isSealed) {
      writeFileSync(filePath, crypt.openBytes(bytes));
      filesDone++;
    } else if (!off && !isSealed) {
      writeFileSync(filePath, crypt.sealBytes(bytes));
      filesDone++;
    }
  } catch (err) {
    // A missing or unreadable file should not abort the run; the database row
    // will simply keep pointing at something that cannot be served.
    console.warn(`  ! could not convert ${filePath}: ${err.message}`);
  }
}
console.log('  uploaded files'.padEnd(28) + (filesDone ? `${filesDone} converted` : 'nothing to do'));

// Rewriting a row leaves the old bytes in a free page, so the plaintext this
// script just replaced is still in the file until it is reclaimed. VACUUM
// rebuilds the file without the free pages, which is the step that actually
// removes it.
if (changed || filesDone || codes || events) {
  process.stdout.write('\n  compacting the file to drop the old plaintext… ');
  handle.exec('VACUUM');
  console.log('done');
}

console.log(`\n${changed} value${changed === 1 ? '' : 's'} converted to ${wanted}.`);
if (off) {
  console.log('\nRemove RELAY_ENCRYPTION_KEY from the environment and restart.');
} else {
  console.log('\nKeep RELAY_ENCRYPTION_KEY set. Without it the server starts, but every');
  console.log('encrypted message reads as "[encrypted — no key configured]".');
}
db.close();

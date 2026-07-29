#!/usr/bin/env node
// admin.js — grant, revoke and list administrators.
//
// This is the only way to confer the flag, alongside RELAY_ADMIN_EMAIL. No
// route in the running app writes users.is_admin, which means a stolen session
// — even an administrator's — cannot create a second administrator or promote
// an accomplice. Doing that needs shell access to the server, which is a much
// higher bar than a cookie.
//
//   npm run admin                        list administrators
//   npm run admin -- --grant you@x.com   confer the flag
//   npm run admin -- --revoke you@x.com  take it away
//
// Every change is written to the same audit log the dashboard shows, attributed
// to the operating-system user who ran the command.

import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { userInfo, hostname } from 'node:os';
import { randomUUID } from 'node:crypto';

import * as db from '../server/db.js';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const DB_FILE = process.env.RELAY_DB || join(ROOT, 'data', 'relay.db');

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? null : args[i + 1];
};

const die = (message) => { console.error(message); process.exit(1); };

db.open(DB_FILE);
const handle = db.handle();

/** Attribute the change to whoever ran the command, not to an app account. */
function record(action, target, detail) {
  let who = 'shell';
  try { who = `${userInfo().username}@${hostname()}`; } catch { /* no os user */ }
  handle.prepare(
    `INSERT INTO admin_audit (id, actor_id, actor_name, action, target_type, target_id, detail, ip, at)
     VALUES (?,NULL,?,?,'user',?,?, 'cli', ?)`,
  ).run(`al-${randomUUID()}`, who, action, target, detail, Date.now());
}

const grant = flag('grant');
const revoke = flag('revoke');

if (grant && revoke) die('Pass one of --grant or --revoke, not both.');

if (grant || revoke) {
  const email = String(grant || revoke).trim().toLowerCase();
  const user = handle.prepare('SELECT id, name, email, is_guest, is_admin FROM users WHERE email = ?').get(email);
  if (!user) die(`No account with the email ${email}.`);

  // A guest session is handed to anyone who asks for one; it must never carry
  // moderation powers. The dashboard refuses guests too — this refuses earlier,
  // so the flag is never set in the first place.
  if (user.is_guest) die('Guest accounts cannot be administrators.');

  const want = grant ? 1 : 0;
  if (user.is_admin === want) {
    console.log(`${user.name} <${email}> is already ${want ? 'an administrator' : 'not an administrator'}.`);
    db.close();
    process.exit(0);
  }

  if (revoke) {
    const remaining = handle.prepare(
      'SELECT COUNT(*) AS n FROM users WHERE is_admin = 1 AND id != ?',
    ).get(user.id).n;
    if (remaining === 0) {
      console.warn('Warning: this was the last administrator. Nobody will be able to read reports'
        + ' until you grant the flag again.');
    }
  }

  handle.prepare('UPDATE users SET is_admin = ? WHERE id = ?').run(want, user.id);
  record(grant ? 'admin.grant' : 'admin.revoke', user.id, `${user.name} <${email}>`);
  console.log(`${grant ? 'Granted' : 'Revoked'} administrator for ${user.name} <${email}>.`);
  console.log('Takes effect on their next request — the flag is re-read per request, not cached in the session.');
  db.close();
  process.exit(0);
}

const admins = handle.prepare(
  'SELECT name, username, email, created_at FROM users WHERE is_admin = 1 ORDER BY created_at',
).all();

if (!admins.length) {
  console.log('No administrators. Nobody can read abuse reports through the dashboard.\n');
  console.log('Grant one with:  npm run admin -- --grant you@example.com');
} else {
  console.log(`${admins.length} administrator${admins.length === 1 ? '' : 's'}:\n`);
  for (const a of admins) {
    console.log(`  ${a.name}  @${a.username || '?'}  <${a.email}>`);
  }
  console.log('\nRevoke with:  npm run admin -- --revoke someone@example.com');
}
db.close();

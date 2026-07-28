#!/usr/bin/env node
// reports.js — read and resolve abuse reports from the command line.
//
// Relay has no moderation screen yet. Reports are stored properly and this
// makes them readable without one, so "you can report someone" is not a button
// that quietly goes nowhere.
//
//   npm run reports                    open reports
//   npm run reports -- --status all    every report
//   npm run reports -- --resolve <id> --status actioned

import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as db from '../server/db.js';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const DB_FILE = process.env.RELAY_DB || join(ROOT, 'data', 'relay.db');

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};

db.open(DB_FILE);

const resolveId = flag('resolve');
const status = flag('status', resolveId ? 'reviewed' : 'open');

if (resolveId) {
  const allowed = ['open', 'reviewed', 'actioned', 'dismissed'];
  if (!allowed.includes(status)) {
    console.error(`--status must be one of: ${allowed.join(', ')}`);
    process.exit(1);
  }
  const info = db.handle().prepare('UPDATE reports SET status = ? WHERE id = ?').run(status, resolveId);
  console.log(info.changes ? `Report ${resolveId} marked ${status}.` : `No report with id ${resolveId}.`);
  db.close();
  process.exit(0);
}

const rows = status === 'all'
  ? db.handle().prepare(`
      SELECT r.*, reporter.name AS reporter_name, subject.name AS subject_name, subject.email AS subject_email
        FROM reports r
        LEFT JOIN users reporter ON reporter.id = r.reporter_id
        LEFT JOIN users subject ON subject.id = r.subject_id
       ORDER BY r.created_at DESC`).all()
  : db.handle().prepare(`
      SELECT r.*, reporter.name AS reporter_name, subject.name AS subject_name, subject.email AS subject_email
        FROM reports r
        LEFT JOIN users reporter ON reporter.id = r.reporter_id
        LEFT JOIN users subject ON subject.id = r.subject_id
       WHERE r.status = ? ORDER BY r.created_at DESC`).all(status);

if (!rows.length) {
  console.log(status === 'all' ? 'No reports.' : `No ${status} reports.`);
  db.close();
  process.exit(0);
}

console.log(`${rows.length} ${status === 'all' ? '' : status + ' '}report${rows.length === 1 ? '' : 's'}:\n`);
for (const r of rows) {
  console.log(`  ${r.id}   [${r.status}]  ${new Date(r.created_at).toISOString()}`);
  console.log(`    ${r.reporter_name || 'a deleted account'} reported ${r.subject_name || 'a deleted account'}`
    + `${r.subject_email ? ` <${r.subject_email}>` : ''}`);
  console.log(`    reason: ${r.reason}`);
  if (r.note) console.log(`    note:   ${r.note}`);
  if (r.message_text) console.log(`    quoted: ${JSON.stringify(r.message_text.slice(0, 160))}`);
  console.log('');
}
console.log('Resolve one with:  npm run reports -- --resolve <id> --status actioned');
db.close();

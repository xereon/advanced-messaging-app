// Presence has to survive more than one worker process.
//
// On cPanel/Passenger — and on any host that runs several instances — each
// worker has its own memory. Presence used to live only in the worker holding
// the SSE stream, so an account connected through worker A appeared offline to
// anyone served by worker B. This reproduces that shape: two servers over one
// shared database file.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as db from '../server/db.js';
import * as auth from '../server/auth.js';
import * as rt from '../server/realtime.js';
import * as files from '../server/files.js';
import { createApp } from '../server/index.js';
import { seedBots } from '../server/bots.js';

let dir;
let server;
let base;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'relay-presence-'));
  db.open(join(dir, 'shared.db'));
  await files.init(join(dir, 'uploads'));
  seedBots();
  auth.setRateLimitEnabled(false);
  server = createApp();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  rt.closeAll();
  await new Promise((r) => server.close(r));
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

async function register(name, email) {
  const res = await fetch(`${base}/api/auth/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Relay-Client': '1' },
    body: JSON.stringify({ name, email, password: 'hunter2hunter' }),
  });
  const body = await res.json();
  return { cookie: res.headers.getSetCookie()[0].split(';')[0], user: body.user };
}

/** Hold an SSE stream open, the way a signed-in browser tab does. */
async function openStream(cookie) {
  const controller = new AbortController();
  const res = await fetch(`${base}/api/events`, {
    headers: { Cookie: cookie },
    signal: controller.signal,
  });
  assert.equal(res.status, 200);
  // Start draining so the connection is genuinely established.
  const reader = res.body.getReader();
  reader.read().catch(() => {});
  return { close: () => { try { controller.abort(); } catch { /* already gone */ } } };
}

describe('presence is readable by any worker', () => {
  test('it is derived from the database, not one process’s memory', async () => {
    const alice = await register('Alice Present', 'alice@presence.test');
    const stream = await openStream(alice.cookie);
    await new Promise((r) => setTimeout(r, 150));

    // A worker with no stream of its own must still see her as online. Clearing
    // the in-process set is exactly what a second worker's memory looks like.
    const online = rt.onlineUserIds();
    assert.ok(online.includes(alice.user.id), 'the heartbeat must be visible to every worker');

    const row = db.handle().prepare('SELECT last_seen FROM users WHERE id = ?').get(alice.user.id);
    assert.ok(row.last_seen > Date.now() - 10_000, 'connecting writes a heartbeat');
    stream.close();
  });

  test('a brand-new account sees an already-connected one as online', async () => {
    const alice = await register('Alice Two', 'alice2@presence.test');
    const stream = await openStream(alice.cookie);
    await new Promise((r) => setTimeout(r, 150));

    // Bob registers afterwards and shares nothing with Alice.
    const bob = await register('Bob Later', 'bob@presence.test');
    const boot = await (await fetch(`${base}/api/bootstrap`, { headers: { Cookie: bob.cookie } })).json();
    assert.ok(boot.online.includes(alice.user.id),
      'the account that signed in first must show as online');

    const poll = await (await fetch(`${base}/api/presence`, { headers: { Cookie: bob.cookie } })).json();
    assert.ok(poll.online.includes(alice.user.id), 'and the poll must agree');
    stream.close();
  });

  test('a search result carries the right presence for a stranger', async () => {
    const carol = await register('Carol Online', 'carol@presence.test');
    const stream = await openStream(carol.cookie);
    await new Promise((r) => setTimeout(r, 150));

    const dave = await register('Dave Watcher', 'dave@presence.test');
    const found = await (await fetch(`${base}/api/users?q=carol`, { headers: { Cookie: dave.cookie } })).json();
    assert.ok(found.users.some((u) => u.id === carol.user.id));

    const profile = await (await fetch(`${base}/api/users/${carol.user.id}`, { headers: { Cookie: dave.cookie } })).json();
    assert.equal(profile.online, true, 'the profile card must not say offline');
    stream.close();
  });

  test('disconnecting takes the account offline promptly', async () => {
    const erin = await register('Erin Leaves', 'erin@presence.test');
    const stream = await openStream(erin.cookie);
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(rt.isOnline(erin.user.id), true);

    stream.close();
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(rt.isOnline(erin.user.id), false,
      'closing the tab must not leave a stale online indicator');
  });

  test('a stale heartbeat expires rather than lingering forever', async () => {
    const frank = await register('Frank Stale', 'frank@presence.test');
    // Backdate the heartbeat past the window, as a crashed worker would leave it.
    db.handle().prepare('UPDATE users SET last_seen = ? WHERE id = ?')
      .run(Date.now() - rt.PRESENCE_TTL_MS - 5000, frank.user.id);
    assert.equal(rt.isOnline(frank.user.id), false);
    assert.ok(!rt.onlineUserIds().includes(frank.user.id));
  });

  test('bots are always available', async () => {
    assert.equal(rt.isOnline('u-bot-ava'), true);
    assert.ok(rt.onlineUserIds().includes('u-bot-ava'));
  });

  test('the presence endpoint needs a session', async () => {
    assert.equal((await fetch(`${base}/api/presence`)).status, 401);
  });
});

describe('the client reconciles presence by polling', () => {
  test('it polls, because a pushed event only reaches one worker', async () => {
    const store = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../public/js/store.js', import.meta.url), 'utf8'));
    assert.match(store, /export async function refreshPresence/);
    assert.match(store, /api\.presence\(\)/);
    assert.match(store, /visibilitychange/, 'returning to the tab should re-check');
  });
});

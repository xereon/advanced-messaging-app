// The cross-worker event bus.
//
// Passenger runs a pool of worker processes over one database. An in-process
// fan-out only reaches the clients that worker holds, so a message sent through
// worker B never pushed to a recipient connected to worker A — they saw it only
// after a reload. Presence had the same fault and was fixed first; this covers
// the delivery path, which matters more.
//
// Two servers over one database file stand in for two workers.

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
let workerA;
let workerB;
let baseA;
let baseB;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'relay-bus-'));
  db.open(join(dir, 'shared.db'));
  await files.init(join(dir, 'uploads'));
  // Sign-up seeds starter conversations with the demo accounts, so they have to
  // exist or the foreign key rejects the new account.
  seedBots();
  auth.setRateLimitEnabled(false);

  // Both apps share the module-level database handle, exactly as two workers
  // share the file. What they do not share is the in-memory stream map.
  workerA = createApp();
  workerB = createApp();
  await new Promise((r) => workerA.listen(0, '127.0.0.1', r));
  await new Promise((r) => workerB.listen(0, '127.0.0.1', r));
  baseA = `http://127.0.0.1:${workerA.address().port}`;
  baseB = `http://127.0.0.1:${workerB.address().port}`;
});

after(async () => {
  rt.closeAll();
  await new Promise((r) => workerA.close(r));
  await new Promise((r) => workerB.close(r));
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const H = { 'Content-Type': 'application/json', 'X-Relay-Client': '1' };

async function register(base, name, email) {
  const res = await fetch(`${base}/api/auth/signup`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ name, email, password: 'hunter2hunter' }),
  });
  const body = await res.json();
  const setCookie = res.headers.getSetCookie();
  if (!setCookie.length) throw new Error(`signup failed (${res.status}): ${JSON.stringify(body)}`);
  return { cookie: setCookie[0].split(';')[0], user: body.user };
}

/** Collect SSE frames from one worker, the way a browser tab would. */
function listen(base, cookie) {
  const controller = new AbortController();
  const frames = [];
  const ready = fetch(`${base}/api/events`, { headers: { Cookie: cookie }, signal: controller.signal })
    .then((res) => {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      (async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const parts = buffer.split('\n\n');
            buffer = parts.pop();
            for (const part of parts) {
              const type = /^event: (.+)$/m.exec(part)?.[1];
              const data = /^data: (.+)$/m.exec(part)?.[1];
              const id = /^id: (\d+)$/m.exec(part)?.[1];
              if (type && data) frames.push({ type, id: Number(id), data: JSON.parse(data) });
            }
          }
        } catch { /* aborted */ }
      })();
      return res;
    });
  return { ready, frames, close: () => { try { controller.abort(); } catch { /* gone */ } } };
}

/** Wait for a frame, pumping the bus so we do not depend on the poll timer. */
async function waitForFrame(frames, type, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = frames.find((f) => f.type === type);
    if (hit) return hit;
    rt.pumpBus();
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
}

describe('events cross worker boundaries', () => {
  test('a message sent through one worker reaches a stream on another', async () => {
    const alice = await register(baseA, 'Alice Bus', 'alice@bus.test');
    const bob = await register(baseB, 'Bob Bus', 'bob@bus.test');

    // Alice listens on worker A.
    const stream = listen(baseA, alice.cookie);
    await stream.ready;
    await new Promise((r) => setTimeout(r, 150));

    // Bob sends through worker B.
    const convo = await fetch(`${baseB}/api/conversations`, {
      method: 'POST', headers: { ...H, Cookie: bob.cookie },
      body: JSON.stringify({ type: 'dm', members: [alice.user.id] }),
    }).then((r) => r.json());

    await fetch(`${baseB}/api/conversations/${encodeURIComponent(convo.conversation.id)}/messages`, {
      method: 'POST', headers: { ...H, Cookie: bob.cookie },
      body: JSON.stringify({ text: 'across the worker boundary' }),
    });

    const frame = await waitForFrame(stream.frames, 'message');
    assert.ok(frame, 'the message must be pushed, not wait for a reload');
    assert.equal(frame.data.message.text, 'across the worker boundary');
    stream.close();
  });

  test('typing and read receipts cross too', async () => {
    const alice = await register(baseA, 'Alice Two', 'alice2@bus.test');
    const bob = await register(baseB, 'Bob Two', 'bob2@bus.test');
    const convo = await fetch(`${baseA}/api/conversations`, {
      method: 'POST', headers: { ...H, Cookie: alice.cookie },
      body: JSON.stringify({ type: 'dm', members: [bob.user.id] }),
    }).then((r) => r.json());
    const id = encodeURIComponent(convo.conversation.id);

    const stream = listen(baseA, alice.cookie);
    await stream.ready;
    await new Promise((r) => setTimeout(r, 150));

    await fetch(`${baseB}/api/conversations/${id}/typing`, { method: 'POST', headers: { ...H, Cookie: bob.cookie } });
    assert.ok(await waitForFrame(stream.frames, 'typing'), 'typing must cross workers');

    await fetch(`${baseB}/api/conversations/${id}/read`, {
      method: 'POST', headers: { ...H, Cookie: bob.cookie }, body: JSON.stringify({ at: Date.now() }),
    });
    assert.ok(await waitForFrame(stream.frames, 'read'), 'read receipts must cross workers');
    stream.close();
  });

  test('an event is delivered once, not twice, on its own worker', async () => {
    const alice = await register(baseA, 'Alice Once', 'aliceonce@bus.test');
    const bob = await register(baseA, 'Bob Once', 'bobonce@bus.test');
    const convo = await fetch(`${baseA}/api/conversations`, {
      method: 'POST', headers: { ...H, Cookie: alice.cookie },
      body: JSON.stringify({ type: 'dm', members: [bob.user.id] }),
    }).then((r) => r.json());

    const stream = listen(baseA, alice.cookie);
    await stream.ready;
    await new Promise((r) => setTimeout(r, 150));

    await fetch(`${baseA}/api/conversations/${encodeURIComponent(convo.conversation.id)}/messages`, {
      method: 'POST', headers: { ...H, Cookie: bob.cookie },
      body: JSON.stringify({ text: 'exactly once please' }),
    });
    await waitForFrame(stream.frames, 'message');
    // Pump repeatedly: the tail must not redeliver what it published itself.
    for (let i = 0; i < 5; i++) { rt.pumpBus(); await new Promise((r) => setTimeout(r, 30)); }

    const hits = stream.frames.filter((f) => f.type === 'message' && f.data.message?.text === 'exactly once please');
    assert.equal(hits.length, 1, 'local delivery plus the tail must not double up');
    stream.close();
  });

  test('event ids are globally unique and increasing', async () => {
    const before = db.handle().prepare('SELECT IFNULL(MAX(id),0) AS id FROM events').get().id;
    const alice = await register(baseA, 'Alice Ids', 'aliceids@bus.test');
    const bob = await register(baseB, 'Bob Ids', 'bobids@bus.test');
    const convo = await fetch(`${baseA}/api/conversations`, {
      method: 'POST', headers: { ...H, Cookie: alice.cookie },
      body: JSON.stringify({ type: 'dm', members: [bob.user.id] }),
    }).then((r) => r.json());
    const id = encodeURIComponent(convo.conversation.id);

    // Publish alternately from both workers.
    for (let i = 0; i < 4; i++) {
      const base = i % 2 ? baseA : baseB;
      const cookie = i % 2 ? alice.cookie : bob.cookie;
      await fetch(`${base}/api/conversations/${id}/messages`, {
        method: 'POST', headers: { ...H, Cookie: cookie }, body: JSON.stringify({ text: `ping ${i}` }),
      });
    }

    const ids = db.handle().prepare('SELECT id FROM events WHERE id > ? ORDER BY id').all(before).map((r) => r.id);
    assert.ok(ids.length >= 4);
    assert.deepEqual(ids, [...new Set(ids)], 'ids must never collide between workers');
    assert.deepEqual(ids, [...ids].sort((a, b) => a - b), 'and must increase');
  });

  test('a reconnect replays what was missed, even on a different worker', async () => {
    const alice = await register(baseA, 'Alice Resume', 'aliceresume@bus.test');
    const bob = await register(baseB, 'Bob Resume', 'bobresume@bus.test');
    const convo = await fetch(`${baseA}/api/conversations`, {
      method: 'POST', headers: { ...H, Cookie: alice.cookie },
      body: JSON.stringify({ type: 'dm', members: [bob.user.id] }),
    }).then((r) => r.json());
    const id = encodeURIComponent(convo.conversation.id);

    const lastSeen = db.handle().prepare('SELECT IFNULL(MAX(id),0) AS id FROM events').get().id;

    // Alice is disconnected while Bob sends through the other worker.
    await fetch(`${baseB}/api/conversations/${id}/messages`, {
      method: 'POST', headers: { ...H, Cookie: bob.cookie }, body: JSON.stringify({ text: 'sent while away' }),
    });

    // She reconnects to worker A, asking to resume.
    const res = await fetch(`${baseA}/api/events`, {
      headers: { Cookie: alice.cookie, 'Last-Event-ID': String(lastSeen) },
    });
    const text = await Promise.race([
      res.body.getReader().read().then(({ value }) => new TextDecoder().decode(value)),
      new Promise((r) => setTimeout(() => r(''), 2000)),
    ]);
    assert.match(text, /sent while away/, 'the replay must come from the shared table');
  });
});

describe('rate limits are shared, not per worker', () => {
  test('a limit counts across workers instead of being multiplied by them', async () => {
    await register(baseA, 'Limit Target', 'limits@bus.test');
    auth.setRateLimitEnabled(true);
    auth.resetRateLimits();

    let blockedOn = null;
    // Alternate workers. Counting in process memory would let each worker run
    // its own tally, so the cap would arrive at roughly double.
    for (let i = 0; i < 40 && blockedOn === null; i++) {
      const base = i % 2 ? baseA : baseB;
      const res = await fetch(`${base}/api/auth/login`, {
        method: 'POST', headers: H,
        body: JSON.stringify({ email: 'limits@bus.test', password: `wrong-${i}` }),
      });
      if (res.status === 429) blockedOn = i + 1;
    }
    auth.setRateLimitEnabled(false);
    auth.resetRateLimits();

    assert.ok(blockedOn !== null, 'the limit must eventually apply');
    // The per-account cap is 8 in 15 minutes; allow slack for the per-IP cap.
    assert.ok(blockedOn <= 22, `expected the shared cap to bite early, bit at ${blockedOn}`);
  });
});

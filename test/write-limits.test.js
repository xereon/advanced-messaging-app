// write-limits.test.js — per-account budgets on the writing side of the API.
//
// Signing in has been throttled since the start. Writing had nothing, which
// left one script able to flood a conversation faster than anyone could read
// it. These pin the refusal, the Retry-After that makes it recoverable, and the
// two properties that are easy to get wrong: that the budget belongs to an
// account rather than an address, and that a normal rate never touches it.

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { startTestServer, signUp, client } from './helpers.js';
import * as auth from '../server/auth.js';

let srv;
// Accounts are made before limits go on, because signing up is itself limited
// and the suite would otherwise throttle itself out of its own fixtures.
let alice; let bob; let guest; let convo; let guestConvo;

before(async () => {
  srv = await startTestServer();
  alice = await signUp(srv.base, 'Limit Alice', 'alice@limits.test');
  bob = await signUp(srv.base, 'Limit Bob', 'bob@limits.test');

  const made = await alice.client.post('/api/conversations', { type: 'dm', members: [bob.user.id] });
  convo = made.body.conversation.id;

  guest = client(srv.base);
  const g = await guest.post('/api/auth/guest');
  const guestId = g.body.user.id;
  const gc = await guest.post('/api/conversations', { type: 'dm', members: [alice.user.id] });
  guestConvo = gc.body.conversation.id;
  assert.ok(guestId && guestConvo, 'guest fixture');
});

after(async () => {
  auth.setRateLimitEnabled(false);
  await srv.stop();
});

// Every test starts with an empty counter table, so one test's burst cannot
// exhaust the next one's budget.
beforeEach(() => {
  auth.resetRateLimits();
  auth.setRateLimitEnabled(true);
});

/** Send `n` messages one after another and report the statuses seen. */
async function sendBurst(c, convoId, n) {
  const statuses = [];
  for (let i = 0; i < n; i += 1) {
    const res = await c.post(`/api/conversations/${convoId}/messages`, { text: `burst ${i}` });
    statuses.push(res.status);
    if (res.status === 429) return { statuses, refusal: res };
  }
  return { statuses, refusal: null };
}

describe('sending', () => {
  test('a burst past the budget is refused', async () => {
    const { statuses, refusal } = await sendBurst(alice.client, convo, 40);
    assert.ok(refusal, 'expected a refusal within 40 messages');
    // 30 in ten seconds is the budget, so the 31st is the first refusal.
    assert.equal(statuses.filter((s) => s === 201).length, 30);
    assert.equal(refusal.status, 429);
  });

  test('the refusal says when to try again, in the header and the body', async () => {
    const { refusal } = await sendBurst(alice.client, convo, 40);
    const header = Number(refusal.headers.get('Retry-After'));
    assert.ok(Number.isInteger(header), `Retry-After was ${refusal.headers.get('Retry-After')}`);
    // The send burst window is ten seconds, so the wait can never exceed it.
    assert.ok(header >= 1 && header <= 10, `Retry-After out of range: ${header}`);
    assert.equal(refusal.body.retryAfter, header);
  });

  test('the refusal explains itself rather than saying "error"', async () => {
    const { refusal } = await sendBurst(alice.client, convo, 40);
    assert.match(refusal.body.error, /wait a few seconds/i);
  });

  test('a normal rate is never touched', async () => {
    // Twenty in a row is already faster than anyone types and must pass clean.
    const { statuses, refusal } = await sendBurst(alice.client, convo, 20);
    assert.equal(refusal, null);
    assert.deepEqual([...new Set(statuses)], [201]);
  });
});

describe('whose budget it is', () => {
  test('one account exhausting its budget leaves another untouched', async () => {
    const { refusal } = await sendBurst(alice.client, convo, 40);
    assert.ok(refusal, 'alice should be over budget');

    // Same address, same conversation, different account. If the key were the
    // IP, everyone behind one office router would share one budget.
    const bobSend = await bob.client.post(`/api/conversations/${convo}/messages`, { text: 'still fine' });
    assert.equal(bobSend.status, 201);
  });

  test('a second session on the same account shares the budget', async () => {
    // The budget follows the account, so opening a second tab is not a way to
    // buy another one.
    const second = client(srv.base);
    const login = await second.post('/api/auth/login', { email: 'alice@limits.test', password: 'hunter2hunter' });
    assert.equal(login.status, 200);

    const { refusal } = await sendBurst(alice.client, convo, 40);
    assert.ok(refusal, 'first session should be over budget');

    const fromSecond = await second.post(`/api/conversations/${convo}/messages`, { text: 'other tab' });
    assert.equal(fromSecond.status, 429);
  });

  test('a guest gets a smaller budget than an account', async () => {
    const { statuses, refusal } = await sendBurst(guest, guestConvo, 40);
    assert.ok(refusal, 'expected the guest to be refused');
    // Half of thirty: a guest session is handed to whoever asks for one.
    assert.equal(statuses.filter((s) => s === 201).length, 15);
  });
});

describe('the other write paths', () => {
  test('starting conversations is limited', async () => {
    let refused = null;
    for (let i = 0; i < 20 && !refused; i += 1) {
      const other = await signUp(srv.base, `Fresh ${i}`, `fresh${i}@limits.test`);
      const res = await alice.client.post('/api/conversations', { type: 'dm', members: [other.user.id] });
      if (res.status === 429) refused = res;
    }
    assert.ok(refused, 'expected a refusal while starting conversations');
    assert.match(refused.body.error, /too quickly/i);
  });

  test('reactions are limited', async () => {
    const sent = await alice.client.post(`/api/conversations/${convo}/messages`, { text: 'react to me' });
    const msgId = sent.body.message.id;

    let refused = null;
    // Toggling the same emoji on and off is the cheapest way to make noise.
    for (let i = 0; i < 80 && !refused; i += 1) {
      const res = await alice.client.post(`/api/messages/${msgId}/reactions`, { emoji: i % 2 ? '👍' : '🎉' });
      if (res.status === 429) refused = res;
    }
    assert.ok(refused, 'expected a refusal while reacting');
  });

  test('typing notices are limited', async () => {
    let refused = null;
    for (let i = 0; i < 140 && !refused; i += 1) {
      const res = await alice.client.post(`/api/conversations/${convo}/typing`, {});
      if (res.status === 429) refused = res;
    }
    assert.ok(refused, 'expected a refusal while sending typing notices');
  });

  test('message search is limited', async () => {
    let refused = null;
    for (let i = 0; i < 80 && !refused; i += 1) {
      const res = await alice.client.get('/api/search/messages?q=hello');
      if (res.status === 429) refused = res;
    }
    assert.ok(refused, 'expected a refusal while searching');
  });

  test('profile edits are limited', async () => {
    let refused = null;
    for (let i = 0; i < 40 && !refused; i += 1) {
      const res = await alice.client.patch('/api/profile', { statusText: `spin ${i}` });
      if (res.status === 429) refused = res;
    }
    assert.ok(refused, 'expected a refusal while editing the profile');
  });

  test('editing a message is limited', async () => {
    const sent = await alice.client.post(`/api/conversations/${convo}/messages`, { text: 'first' });
    const msgId = sent.body.message.id;

    let refused = null;
    for (let i = 0; i < 80 && !refused; i += 1) {
      const res = await alice.client.patch(`/api/messages/${msgId}`, { text: `revision ${i}` });
      if (res.status === 429) refused = res;
    }
    assert.ok(refused, 'expected a refusal while editing');
  });

  test('reading history is not limited', async () => {
    // Paging back through a long conversation is normal use, and a scroll that
    // stops loading looks like a broken app rather than a protected one.
    for (let i = 0; i < 60; i += 1) {
      const res = await alice.client.get(`/api/conversations/${convo}/messages?limit=5`);
      assert.equal(res.status, 200, `history call ${i} was refused`);
    }
  });
});

describe('retryAfterSeconds', () => {
  test('counts down within the window rather than restating its length', () => {
    auth.rateLimit('unit:countdown', { limit: 1, windowMs: 60 * 1000 });
    const wait = auth.retryAfterSeconds('unit:countdown', 60 * 1000);
    assert.ok(wait > 0 && wait <= 60, `wait was ${wait}`);
  });

  test('never says zero, because zero invites an instant retry', () => {
    // A window that has already elapsed: the honest answer is "now", but a
    // client told to wait zero seconds retries into the same refusal.
    auth.rateLimit('unit:elapsed', { limit: 1, windowMs: 1 });
    assert.equal(auth.retryAfterSeconds('unit:elapsed', 1), 1);
  });

  test('an unknown key is safe to ask about', () => {
    assert.equal(auth.retryAfterSeconds('unit:never-seen', 1000), 1);
  });
});

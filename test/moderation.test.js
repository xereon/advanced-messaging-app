// Blocking has to hold on every path a message or a name can travel, not just
// the send endpoint. A block that stops direct messages but still leaks the
// person through search, history, profiles or push is not a block. These tests
// walk each of those routes.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { startTestServer, signUp, client } from './helpers.js';
import * as db from '../server/db.js';
import * as rt from '../server/realtime.js';

let srv;
before(async () => { srv = await startTestServer(); });
after(async () => { await srv.stop(); });

/** Two accounts with a direct conversation and one message already in it. */
async function pair(tag) {
  const a = await signUp(srv.base, `Ann ${tag}`, `ann.${tag}@block.test`);
  const b = await signUp(srv.base, `Bob ${tag}`, `bob.${tag}@block.test`);
  const convo = await a.client.post('/api/conversations', { type: 'dm', members: [b.user.id] });
  const convoId = convo.body.conversation.id;
  await a.client.post(`/api/conversations/${convoId}/messages`, { text: `hello ${tag}` });
  return { a, b, convoId };
}

/** Collect SSE frames the way an open tab would. */
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
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const parts = buffer.split('\n\n');
            buffer = parts.pop();
            for (const part of parts) {
              const type = /^event: (.+)$/m.exec(part)?.[1];
              const data = /^data: (.+)$/m.exec(part)?.[1];
              if (type && data) frames.push({ type, data: JSON.parse(data) });
            }
          }
        } catch { /* aborted */ }
      })();
      return res;
    });
  return { ready, frames, close: () => { try { controller.abort(); } catch { /* gone */ } } };
}

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

describe('blocking', () => {
  test('the blocked person cannot send you a direct message', async () => {
    const { a, b, convoId } = await pair('send');

    const before = await b.client.post(`/api/conversations/${convoId}/messages`, { text: 'still fine' });
    assert.equal(before.status, 201, 'precondition: messages flow before the block');

    const blocked = await a.client.post('/api/blocks', { userId: b.user.id });
    assert.equal(blocked.status, 200);
    assert.deepEqual(blocked.body.blocked, [b.user.id]);

    const after = await b.client.post(`/api/conversations/${convoId}/messages`, { text: 'let me in' });
    assert.equal(after.status, 403);
    // The refusal must not say a block exists, or it becomes a way to detect one.
    assert.ok(!/block/i.test(after.body.error), `leaky error: ${after.body.error}`);
  });

  test('blocking is symmetric — the blocker cannot send either', async () => {
    const { a, b, convoId } = await pair('sym');
    await a.client.post('/api/blocks', { userId: b.user.id });
    const res = await a.client.post(`/api/conversations/${convoId}/messages`, { text: 'one more thing' });
    assert.equal(res.status, 403);
  });

  test('neither side appears in the other\'s directory search', async () => {
    const { a, b } = await pair('dir');
    await a.client.post('/api/blocks', { userId: b.user.id });

    const mine = await a.client.get('/api/users?q=Bob');
    assert.ok(!mine.body.users.some((u) => u.id === b.user.id), 'blocker still sees them');

    const theirs = await b.client.get('/api/users?q=Ann');
    assert.ok(!theirs.body.users.some((u) => u.id === a.user.id), 'blocked user still sees the blocker');
  });

  test('the conversation and its history disappear from both snapshots', async () => {
    const { a, b, convoId } = await pair('hist');
    await a.client.post('/api/blocks', { userId: b.user.id });

    for (const [who, c] of [['blocker', a.client], ['blocked', b.client]]) {
      const boot = await c.get('/api/bootstrap');
      assert.ok(!boot.body.conversations.some((x) => x.id === convoId), `${who} still sees the conversation`);
    }
    const page = await b.client.get(`/api/conversations/${convoId}/messages?before=999999`);
    assert.equal(page.status, 403, 'history must not be readable through the paging endpoint');
  });

  test('their messages drop out of message search', async () => {
    const a = await signUp(srv.base, 'Ann Search', 'ann.search@block.test');
    const b = await signUp(srv.base, 'Bob Search', 'bob.search@block.test');
    const convo = await a.client.post('/api/conversations', { type: 'dm', members: [b.user.id] });
    await b.client.post(`/api/conversations/${convo.body.conversation.id}/messages`, { text: 'pineapple upside down' });

    const found = await a.client.get('/api/search/messages?q=pineapple');
    assert.equal(found.body.results.length, 1, 'precondition: searchable before the block');

    await a.client.post('/api/blocks', { userId: b.user.id });
    const after = await a.client.get('/api/search/messages?q=pineapple');
    assert.equal(after.body.results.length, 0);
  });

  test('the blocked person gets a 404 on the blocker\'s profile, not a "blocked" flag', async () => {
    const { a, b } = await pair('prof');
    await a.client.post('/api/blocks', { userId: b.user.id });

    const theirs = await b.client.get(`/api/users/${a.user.id}`);
    assert.equal(theirs.status, 404);

    // The blocker, on the other hand, is told plainly — they need the toggle.
    const mine = await a.client.get(`/api/users/${b.user.id}`);
    assert.equal(mine.status, 200);
    assert.equal(mine.body.isBlocked, true);
  });

  test('blocking removes them from your contacts', async () => {
    const { a, b } = await pair('contact');
    await a.client.post('/api/contacts', { contactId: b.user.id });
    let boot = await a.client.get('/api/bootstrap');
    assert.ok(boot.body.contacts.includes(b.user.id), 'precondition: a contact');

    await a.client.post('/api/blocks', { userId: b.user.id });
    boot = await a.client.get('/api/bootstrap');
    assert.ok(!boot.body.contacts.includes(b.user.id));
    assert.deepEqual(boot.body.blocked, [b.user.id]);
  });

  test('unblocking restores the conversation and its messages', async () => {
    const { a, b, convoId } = await pair('undo');
    await a.client.post('/api/blocks', { userId: b.user.id });
    const del = await a.client.del(`/api/blocks/${b.user.id}`);
    assert.equal(del.status, 200);
    assert.deepEqual(del.body.blocked, []);

    const boot = await a.client.get('/api/bootstrap');
    const convo = boot.body.conversations.find((c) => c.id === convoId);
    assert.ok(convo, 'the conversation comes back');
    assert.ok(boot.body.messages[convoId].some((m) => m.text === 'hello undo'), 'so does the history');

    const sent = await b.client.post(`/api/conversations/${convoId}/messages`, { text: 'back again' });
    assert.equal(sent.status, 201);
  });

  test('a group both belong to still works — blocking is a direct-message tool', async () => {
    const a = await signUp(srv.base, 'Ann Group', 'ann.group@block.test');
    const b = await signUp(srv.base, 'Bob Group', 'bob.group@block.test');
    const c = await signUp(srv.base, 'Cara Group', 'cara.group@block.test');
    const group = await c.client.post('/api/conversations', {
      type: 'group', title: 'Project', members: [a.user.id, b.user.id],
    });
    const gid = group.body.conversation.id;

    await a.client.post('/api/blocks', { userId: b.user.id });
    const sent = await b.client.post(`/api/conversations/${gid}/messages`, { text: 'group note' });
    assert.equal(sent.status, 201, 'a shared group is not silenced by a personal block');

    const boot = await a.client.get('/api/bootstrap');
    assert.ok(boot.body.conversations.some((x) => x.id === gid), 'the group stays in the list');
  });

  test('you cannot block yourself, or a stranger who does not exist', async () => {
    const { client: c, user } = await signUp(srv.base, 'Solo Block', 'solo@block.test');
    assert.equal((await c.post('/api/blocks', { userId: user.id })).status, 400);
    assert.equal((await c.post('/api/blocks', { userId: 'u_nope' })).status, 404);
  });

  test('blocking twice is not an error and does not duplicate the entry', async () => {
    const { a, b } = await pair('twice');
    await a.client.post('/api/blocks', { userId: b.user.id });
    const again = await a.client.post('/api/blocks', { userId: b.user.id });
    assert.equal(again.status, 200);
    assert.deepEqual(again.body.blocked, [b.user.id]);
  });

  test('both sides are told to redraw, and the blocked side is told nothing else', async () => {
    const { a, b } = await pair('live');
    const theirs = listen(srv.base, b.client.cookie);
    const mine = listen(srv.base, a.client.cookie);
    await Promise.all([theirs.ready, mine.ready]);
    await new Promise((r) => setTimeout(r, 150));

    await a.client.post('/api/blocks', { userId: b.user.id });

    const nudge = await waitForFrame(theirs.frames, 'refresh');
    assert.ok(nudge, 'the blocked side must be told to rebuild its view');
    assert.deepEqual(nudge.data, {}, 'the nudge carries no hint that a block happened');

    const own = await waitForFrame(mine.frames, 'blocks');
    assert.deepEqual(own.data.blocked, [b.user.id], 'your other tabs get the new list');

    theirs.close();
    mine.close();
  });

  test('the block list is visible to the person who made it', async () => {
    const { a, b } = await pair('list');
    await a.client.post('/api/blocks', { userId: b.user.id });

    const res = await a.client.get('/api/blocks');
    assert.equal(res.status, 200);
    assert.equal(res.body.blocked.length, 1);
    assert.equal(res.body.blocked[0].name, 'Bob list');

    // The other side's list stays empty — they did not block anyone.
    const theirs = await b.client.get('/api/blocks');
    assert.deepEqual(theirs.body.blocked, []);
  });

  test('signed-out callers cannot touch the block list', async () => {
    const anon = client(srv.base);
    assert.equal((await anon.post('/api/blocks', { userId: 'u_x' })).status, 401);
  });
});

describe('reporting', () => {
  test('a report is stored with the offending message quoted', async () => {
    const a = await signUp(srv.base, 'Ann Report', 'ann.report@block.test');
    const b = await signUp(srv.base, 'Bob Report', 'bob.report@block.test');
    const convo = await a.client.post('/api/conversations', { type: 'dm', members: [b.user.id] });
    const convoId = convo.body.conversation.id;
    const msg = await b.client.post(`/api/conversations/${convoId}/messages`, { text: 'buy my coins' });

    const res = await a.client.post('/api/reports', {
      subjectId: b.user.id, convoId, messageId: msg.body.message.id,
      reason: 'spam', note: 'third time today',
    });
    assert.equal(res.status, 201);

    const row = db.handle().prepare('SELECT * FROM reports WHERE id = ?').get(res.body.id);
    assert.equal(row.reporter_id, a.user.id);
    assert.equal(row.subject_id, b.user.id);
    assert.equal(row.reason, 'spam');
    assert.equal(row.note, 'third time today');
    assert.equal(row.status, 'open');
    // The quote is snapshotted: deleting the message must not erase the evidence.
    assert.equal(row.message_text, 'buy my coins');
  });

  test('a report survives the reporter deleting the conversation message', async () => {
    const a = await signUp(srv.base, 'Ann Keep', 'ann.keep@block.test');
    const b = await signUp(srv.base, 'Bob Keep', 'bob.keep@block.test');
    const convo = await a.client.post('/api/conversations', { type: 'dm', members: [b.user.id] });
    const msg = await b.client.post(`/api/conversations/${convo.body.conversation.id}/messages`, { text: 'nasty thing' });

    const res = await a.client.post('/api/reports', {
      subjectId: b.user.id, messageId: msg.body.message.id, reason: 'harassment',
    });
    await b.client.del(`/api/messages/${msg.body.message.id}`);

    const row = db.handle().prepare('SELECT message_text FROM reports WHERE id = ?').get(res.body.id);
    assert.equal(row.message_text, 'nasty thing');
  });

  test('a made-up reason is refused', async () => {
    const a = await signUp(srv.base, 'Ann Reason', 'ann.reason@block.test');
    const b = await signUp(srv.base, 'Bob Reason', 'bob.reason@block.test');
    const res = await a.client.post('/api/reports', { subjectId: b.user.id, reason: 'because' });
    assert.equal(res.status, 400);
  });

  test('you cannot quote a message from a conversation you are not in', async () => {
    const a = await signUp(srv.base, 'Ann Nosy', 'ann.nosy@block.test');
    const b = await signUp(srv.base, 'Bob Private', 'bob.private@block.test');
    const c = await signUp(srv.base, 'Cara Private', 'cara.private@block.test');
    const convo = await b.client.post('/api/conversations', { type: 'dm', members: [c.user.id] });
    const msg = await b.client.post(`/api/conversations/${convo.body.conversation.id}/messages`, { text: 'private words' });

    const res = await a.client.post('/api/reports', {
      subjectId: b.user.id, messageId: msg.body.message.id, reason: 'spam',
    });
    assert.equal(res.status, 403, 'reporting must not become a way to read other people\'s messages');
  });

  test('reports are invisible to ordinary accounts', async () => {
    const { client: c } = await signUp(srv.base, 'Nosy Reader', 'nosy@block.test');
    // 404, not 403: the moderation surface does not confirm it is there.
    // test/admin.test.js covers the indistinguishability in full.
    assert.equal((await c.get('/api/admin/reports')).status, 404);
    assert.equal((await c.patch('/api/admin/reports/r_1', { status: 'dismissed' })).status, 404);
  });

  test('an administrator can list and resolve reports', async () => {
    const a = await signUp(srv.base, 'Ann Admin', 'ann.admin@block.test');
    const b = await signUp(srv.base, 'Bob Admin', 'bob.admin@block.test');
    const res = await b.client.post('/api/reports', { subjectId: a.user.id, reason: 'other', note: 'odd' });

    db.handle().prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(a.user.id);

    const list = await a.client.get('/api/admin/reports');
    assert.equal(list.status, 200);
    const found = list.body.reports.find((r) => r.id === res.body.id);
    assert.ok(found, 'the report is listed');
    assert.equal(found.reporter.name, 'Bob Admin');

    const patched = await a.client.patch(`/api/admin/reports/${res.body.id}`, { status: 'actioned' });
    assert.equal(patched.status, 200);
    const after = await a.client.get('/api/admin/reports');
    assert.ok(!after.body.reports.some((r) => r.id === res.body.id), 'resolved reports leave the open queue');
  });

  test('you cannot report yourself', async () => {
    const { client: c, user } = await signUp(srv.base, 'Self Report', 'self@block.test');
    assert.equal((await c.post('/api/reports', { subjectId: user.id, reason: 'spam' })).status, 400);
  });
});

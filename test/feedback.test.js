// Feedback from the account menu.
//
// The point of the feature is that it lands somewhere a human will read it, so
// most of what matters is that it is stored, that it reaches the dashboard, and
// that it is no more readable than a report is.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { startTestServer, signUp, client } from './helpers.js';
import * as db from '../server/db.js';

let srv;
before(async () => { srv = await startTestServer(); });
after(async () => { await srv.stop(); });

const makeAdmin = (id) => db.handle().prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(id);

describe('sending feedback', () => {
  test('is stored with the kind, the message and who sent it', async () => {
    const me = await signUp(srv.base, 'Fern Sender', 'fern@fb.test');
    const res = await me.client.post('/api/feedback', {
      kind: 'bug', message: 'The unread badge sticks after I read a message.',
    });
    assert.equal(res.status, 201);

    const row = db.handle().prepare('SELECT * FROM feedback WHERE id = ?').get(res.body.id);
    assert.equal(row.author_id, me.user.id);
    assert.equal(row.author_name, 'Fern Sender');
    assert.equal(row.kind, 'bug');
    assert.equal(row.message, 'The unread badge sticks after I read a message.');
    assert.equal(row.status, 'new');
    assert.ok(row.at ?? row.created_at);
  });

  test('every kind the dialog offers is accepted, and nothing else is', async () => {
    const me = await signUp(srv.base, 'Kind Tester', 'kinds@fb.test');
    for (const kind of ['idea', 'bug', 'accessibility', 'praise', 'other']) {
      const res = await me.client.post('/api/feedback', { kind, message: `about ${kind}` });
      assert.equal(res.status, 201, `${kind} must be accepted`);
    }
    for (const kind of ['urgent', '', null, 'IDEA', 'sql']) {
      const res = await me.client.post('/api/feedback', { kind, message: 'hello' });
      assert.equal(res.status, 400, `${JSON.stringify(kind)} must be refused`);
    }
  });

  test('an empty message is refused, and whitespace does not count', async () => {
    const me = await signUp(srv.base, 'Empty Sender', 'empty@fb.test');
    for (const message of ['', '   ', '\n\t ', null, undefined]) {
      const res = await me.client.post('/api/feedback', { kind: 'idea', message });
      assert.equal(res.status, 400);
    }
  });

  test('an overlong message is trimmed rather than rejected', async () => {
    const me = await signUp(srv.base, 'Long Sender', 'long@fb.test');
    const res = await me.client.post('/api/feedback', { kind: 'other', message: 'x'.repeat(5000) });
    assert.equal(res.status, 201, 'someone who typed too much should not lose it all');
    const row = db.handle().prepare('SELECT message FROM feedback WHERE id = ?').get(res.body.id);
    assert.equal(row.message.length, 2000);
  });

  test('signing in is required', async () => {
    const anon = client(srv.base);
    assert.equal((await anon.post('/api/feedback', { kind: 'idea', message: 'hi' })).status, 401);
  });

  test('a guest can send it too — they are users with opinions', async () => {
    const guest = client(srv.base);
    await guest.post('/api/auth/guest');
    const res = await guest.post('/api/feedback', { kind: 'accessibility', message: 'Text is small.' });
    assert.equal(res.status, 201);
  });

  test('nothing about the browser or the account is collected beyond the name', async () => {
    const me = await signUp(srv.base, 'Private Sender', 'private@fb.test');
    const res = await me.client.post('/api/feedback', {
      kind: 'idea', message: 'Dark mode by default.',
      // A client that sent these anyway must not have them stored.
      userAgent: 'Mozilla/5.0 (spying)', ip: '1.2.3.4', screen: '1920x1080',
    });
    const row = db.handle().prepare('SELECT * FROM feedback WHERE id = ?').get(res.body.id);
    assert.ok(!JSON.stringify(row).includes('spying'), 'a user agent must not be stored');
    assert.ok(!JSON.stringify(row).includes('1.2.3.4'));
    assert.deepEqual(
      Object.keys(row).sort(),
      ['author_id', 'author_name', 'created_at', 'id', 'kind', 'message', 'status'],
      'the row holds exactly what the dialog said it would send',
    );
  });
});

describe('feedback on the dashboard', () => {
  test('an administrator sees it, with a way to reply', async () => {
    const boss = await signUp(srv.base, 'Boss Reader', 'boss@fb.test');
    const sender = await signUp(srv.base, 'Sender One', 'sender1@fb.test');
    const sent = await sender.client.post('/api/feedback', { kind: 'idea', message: 'Add threads.' });
    makeAdmin(boss.user.id);

    const res = await boss.client.get('/api/admin/feedback');
    assert.equal(res.status, 200);
    const item = res.body.feedback.find((f) => f.id === sent.body.id);
    assert.ok(item, 'the new feedback is listed');
    assert.equal(item.message, 'Add threads.');
    assert.equal(item.kind, 'idea');
    assert.equal(item.author.name, 'Sender One');
    assert.equal(item.author.email, 'sender1@fb.test', 'so they can be replied to');
    assert.equal(item.author.deleted, false);
  });

  test('nobody else can read it, and the refusal does not admit it exists', async () => {
    const sender = await signUp(srv.base, 'Sender Two', 'sender2@fb.test');
    await sender.client.post('/api/feedback', { kind: 'praise', message: 'Nice app.' });

    const nosy = await signUp(srv.base, 'Nosy Reader', 'nosy@fb.test');
    const control = await nosy.client.get('/api/no-such-endpoint');
    const res = await nosy.client.get('/api/admin/feedback');
    assert.equal(res.status, 404);
    assert.deepEqual(res.body, control.body);

    // Nor can the sender read their own back through the admin route.
    assert.equal((await sender.client.get('/api/admin/feedback')).status, 404);
    assert.equal(
      (await sender.client.patch('/api/admin/feedback/fb-1', { status: 'done' })).status, 404,
    );
  });

  test('resolving moves it through the statuses, and is audited', async () => {
    const boss = await signUp(srv.base, 'Boss Triage', 'boss2@fb.test');
    const sender = await signUp(srv.base, 'Sender Three', 'sender3@fb.test');
    const sent = await sender.client.post('/api/feedback', { kind: 'bug', message: 'Scroll jumps.' });
    makeAdmin(boss.user.id);

    const patched = await boss.client.patch(`/api/admin/feedback/${sent.body.id}`, { status: 'planned' });
    assert.equal(patched.status, 200);

    const still = await boss.client.get('/api/admin/feedback?status=new');
    assert.ok(!still.body.feedback.some((f) => f.id === sent.body.id), 'it leaves the new queue');
    const planned = await boss.client.get('/api/admin/feedback?status=planned');
    assert.ok(planned.body.feedback.some((f) => f.id === sent.body.id));

    const entry = db.handle().prepare(
      "SELECT * FROM admin_audit WHERE action = 'feedback.resolve' AND target_id = ?",
    ).get(sent.body.id);
    assert.ok(entry, 'triaging feedback is an administrator action, so it is logged');
    assert.equal(entry.detail, 'new → planned');
    assert.equal(entry.actor_id, boss.user.id);
  });

  test('an unknown status is refused and an unknown id is a 404', async () => {
    const boss = await signUp(srv.base, 'Boss Strict', 'boss3@fb.test');
    makeAdmin(boss.user.id);
    assert.equal((await boss.client.get('/api/admin/feedback?status=whatever')).status, 400);
    assert.equal((await boss.client.patch('/api/admin/feedback/fb-nope', { status: 'done' })).status, 404);
    const real = await signUp(srv.base, 'Sender Four', 'sender4@fb.test');
    const sent = await real.client.post('/api/feedback', { kind: 'other', message: 'hi' });
    assert.equal(
      (await boss.client.patch(`/api/admin/feedback/${sent.body.id}`, { status: 'shipped' })).status, 400,
    );
  });

  test('it survives the sender deleting their account, with the name kept', async () => {
    const boss = await signUp(srv.base, 'Boss Keeper', 'boss4@fb.test');
    const sender = await signUp(srv.base, 'Vanishing Sender', 'vanish@fb.test');
    const sent = await sender.client.post('/api/feedback', { kind: 'idea', message: 'Keep this idea.' });
    makeAdmin(boss.user.id);

    await sender.client.del('/api/account');

    const res = await boss.client.get('/api/admin/feedback?status=all');
    const item = res.body.feedback.find((f) => f.id === sent.body.id);
    assert.ok(item, 'a good idea should not vanish with the account that had it');
    assert.equal(item.message, 'Keep this idea.');
    assert.equal(item.author.name, 'Vanishing Sender');
    assert.equal(item.author.deleted, true, 'and the dashboard says the account is gone');
  });

  test('the overview counts it', async () => {
    const boss = await signUp(srv.base, 'Boss Counter', 'boss5@fb.test');
    makeAdmin(boss.user.id);
    const before = (await boss.client.get('/api/admin/overview')).body.feedback.unread;

    const sender = await signUp(srv.base, 'Sender Five', 'sender5@fb.test');
    await sender.client.post('/api/feedback', { kind: 'idea', message: 'One more thing.' });

    const after = (await boss.client.get('/api/admin/overview')).body.feedback;
    assert.equal(after.unread, before + 1);
    assert.ok(after.total >= after.unread);
  });
});

describe('the dialog', () => {
  test('the menu item and the dialog it opens are both in the page', () => {
    const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
    const ui = readFileSync(new URL('../public/js/ui.js', import.meta.url), 'utf8');

    assert.match(html, /data-action="feedback"/, 'the account menu carries the item');
    assert.match(html, /id="feedback-dialog"/);
    for (const id of ['feedback-message', 'feedback-error', 'feedback-remaining']) {
      assert.match(html, new RegExp(`id="${id}"`), `#${id} must exist`);
      assert.ok(ui.includes(`#${id}`), `#${id} must be used`);
    }
    // Every kind the server accepts has a radio, or one of them is unreachable.
    for (const kind of ['idea', 'bug', 'accessibility', 'praise', 'other']) {
      assert.match(html, new RegExp(`value="${kind}"`), `no way to choose "${kind}"`);
    }
  });

  test('the dashboard renders feedback without innerHTML', () => {
    const src = readFileSync(new URL('../server/admin-ui/admin.js', import.meta.url), 'utf8');
    assert.match(src, /feedbackCard/, 'the dashboard renders it');
    assert.ok(!/innerHTML\s*[+]?=/.test(src),
      'feedback is user-written text on an administrator screen — build nodes, never markup');
  });
});

// Suspension.
//
// The property that matters is that there is no way in. An account that cannot
// sign in with a password but can with a PIN, or that is locked out of sign-in
// but keeps working in the tab it already had open, is not suspended. So most of
// this walks each entry path separately rather than trusting one gate.
//
// The second theme is the opposite of blocking: a suspension is *told* to the
// person. A block is undetectable on purpose because it is one user's private
// choice; being locked out of your own account by the operator is something you
// are owed an explanation for.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { startTestServer, signUp, client } from './helpers.js';
import * as db from '../server/db.js';

let srv;
before(async () => { srv = await startTestServer(); });
after(async () => { await srv.stop(); });

const makeAdmin = (id) => db.handle().prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(id);
const rowFor = (id) => db.handle().prepare('SELECT * FROM users WHERE id = ?').get(id);

/** An administrator and an ordinary account, with a known password. */
async function pair(tag) {
  const boss = await signUp(srv.base, `Boss ${tag}`, `boss.${tag}@susp.test`);
  const user = await signUp(srv.base, `User ${tag}`, `user.${tag}@susp.test`);
  makeAdmin(boss.user.id);
  return { boss, user, email: `user.${tag}@susp.test`, password: 'hunter2hunter' };
}

describe('there is no way in', () => {
  test('the live session stops working immediately, on every route', async () => {
    const { boss, user } = await pair('live');
    assert.equal((await user.client.get('/api/bootstrap')).status, 200, 'precondition');

    await boss.client.post(`/api/admin/users/${user.user.id}/suspension`, { days: 7, reason: 'Spam.' });

    // The same cookie, unchanged. Nothing about the client has been told.
    for (const path of ['/api/bootstrap', '/api/me', '/api/presence', '/api/users?q=boss']) {
      assert.equal((await user.client.get(path)).status, 401, `${path} must refuse`);
    }
    assert.equal((await user.client.post('/api/contacts', { contactId: boss.user.id })).status, 401);
  });

  test('their sessions are deleted, not merely rejected', async () => {
    const { boss, user } = await pair('sessions');
    const before = db.handle().prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?')
      .get(user.user.id).n;
    assert.ok(before > 0, 'precondition: a session exists');

    await boss.client.post(`/api/admin/users/${user.user.id}/suspension`, { days: 1 });

    const after = db.handle().prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?')
      .get(user.user.id).n;
    assert.equal(after, 0, 'a token left in the table is a token that can be replayed');
  });

  test('signing in again with a password is refused, and says why', async () => {
    const { boss, user, email, password } = await pair('pw');
    await boss.client.post(`/api/admin/users/${user.user.id}/suspension`, {
      days: 7, reason: 'Repeated unsolicited advertising.',
    });

    const fresh = client(srv.base);
    const res = await fresh.post('/api/auth/login', { email, password });
    assert.equal(res.status, 403);
    assert.match(res.body.error, /suspended/i);
    assert.match(res.body.error, /Repeated unsolicited advertising\./, 'the reason is given');
    assert.match(res.body.error, /Access returns on/, 'and so is the end date');
  });

  test('an open-ended suspension says so instead of promising a date', async () => {
    const { boss, user, email, password } = await pair('forever');
    await boss.client.post(`/api/admin/users/${user.user.id}/suspension`, { days: null, reason: 'Fraud.' });

    const res = await client(srv.base).post('/api/auth/login', { email, password });
    assert.equal(res.status, 403);
    assert.ok(!/Access returns on/.test(res.body.error));
    assert.match(res.body.error, /Contact the people who run this server/);
  });

  test('the one-time email code is refused too', async () => {
    const { boss, user, email } = await pair('code');
    // Get a code first, so the refusal is not merely "no code issued".
    const asked = await client(srv.base).post('/api/auth/code/request', { email });
    assert.equal(asked.status, 200);
    const code = asked.body.code;
    assert.ok(code, 'precondition: the code is returned when SMTP is unconfigured');

    await boss.client.post(`/api/admin/users/${user.user.id}/suspension`, { days: 7 });

    const res = await client(srv.base).post('/api/auth/code/verify', { email, code });
    assert.equal(res.status, 403, 'a valid code must not be a way around a suspension');
    assert.match(res.body.error, /suspended/i);
  });

  test('the quick-unlock PIN is refused too', async () => {
    const { boss, user } = await pair('pin');
    assert.equal((await user.client.post('/api/account/pin', { pin: '4821' })).status, 200);

    await boss.client.post(`/api/admin/users/${user.user.id}/suspension`, { days: 7 });

    const res = await client(srv.base).post('/api/auth/pin', { userId: user.user.id, pin: '4821' });
    assert.equal(res.status, 403);
    assert.match(res.body.error, /suspended/i);
  });

  test('the live event stream is refused', async () => {
    const { boss, user } = await pair('stream');
    await boss.client.post(`/api/admin/users/${user.user.id}/suspension`, { days: 7 });
    const res = await fetch(`${srv.base}/api/events`, { headers: { Cookie: user.client.cookie } });
    assert.equal(res.status, 401);
    res.body?.cancel?.();
  });

  test('a suspension written straight into the database is honoured', async () => {
    const { user } = await pair('direct');
    // No route involved: this is what a `sqlite3` session or a restore would do.
    db.handle().prepare('UPDATE users SET suspended_at = ? WHERE id = ?').run(Date.now(), user.user.id);
    assert.equal((await user.client.get('/api/bootstrap')).status, 401,
      'the check reads the row, so it does not depend on having gone through suspendUser');
  });
});

describe('what suspension does not do', () => {
  test('their messages stay where they are', async () => {
    const { boss, user } = await pair('messages');
    const other = await signUp(srv.base, 'Bystander One', 'bystander1@susp.test');
    const convo = await user.client.post('/api/conversations', { type: 'dm', members: [other.user.id] });
    await user.client.post(`/api/conversations/${convo.body.conversation.id}/messages`,
      { text: 'something they said earlier' });

    await boss.client.post(`/api/admin/users/${user.user.id}/suspension`, { days: 7 });

    // Suspension stops someone participating. Deleting what they already said
    // would rewrite the other person's conversation.
    const boot = await other.client.get('/api/bootstrap');
    const msgs = boot.body.messages[convo.body.conversation.id] || [];
    assert.ok(msgs.some((m) => m.text === 'something they said earlier'));
  });

  test('they drop out of search, and no new conversation can be opened with them', async () => {
    const { boss, user } = await pair('search');
    const other = await signUp(srv.base, 'Bystander Two', 'bystander2@susp.test');

    const found = await other.client.get('/api/users?q=user');
    assert.ok(found.body.users.some((u) => u.id === user.user.id), 'precondition: findable');

    await boss.client.post(`/api/admin/users/${user.user.id}/suspension`, { days: 7 });

    const after = await other.client.get('/api/users?q=user');
    assert.ok(!after.body.users.some((u) => u.id === user.user.id),
      'offering somebody who cannot answer is a dead end');

    const opened = await other.client.post('/api/conversations', { type: 'dm', members: [user.user.id] });
    assert.equal(opened.status, 403);
    assert.match(opened.body.error, /suspended/i, 'unlike a block, this is stated plainly');
  });

  test('the account is not deleted', async () => {
    const { boss, user } = await pair('exists');
    await boss.client.post(`/api/admin/users/${user.user.id}/suspension`, { days: 7 });
    const row = rowFor(user.user.id);
    assert.ok(row, 'the row is still there');
    assert.ok(row.pw_hash, 'and so are their credentials, ready for the suspension to lift');
  });
});

describe('lifting and lapsing', () => {
  test('lifting it lets them straight back in', async () => {
    const { boss, user, email, password } = await pair('lift');
    await boss.client.post(`/api/admin/users/${user.user.id}/suspension`, { days: 7, reason: 'Cooling off.' });
    assert.equal((await client(srv.base).post('/api/auth/login', { email, password })).status, 403);

    const lifted = await boss.client.del(`/api/admin/users/${user.user.id}/suspension`);
    assert.equal(lifted.status, 200);

    const res = await client(srv.base).post('/api/auth/login', { email, password });
    assert.equal(res.status, 200);

    const row = rowFor(user.user.id);
    assert.equal(row.suspended_at, null);
    assert.equal(row.suspended_reason, null, 'nothing left behind to re-trigger it');
  });

  test('a timed suspension lapses on its own, with no sweeper running', async () => {
    const { boss, user, email, password } = await pair('lapse');
    await boss.client.post(`/api/admin/users/${user.user.id}/suspension`, { days: 1 });
    assert.equal((await client(srv.base).post('/api/auth/login', { email, password })).status, 403);

    // Move the end time into the past, exactly as the clock would have.
    db.handle().prepare('UPDATE users SET suspended_until = ? WHERE id = ?')
      .run(Date.now() - 1000, user.user.id);

    const res = await client(srv.base).post('/api/auth/login', { email, password });
    assert.equal(res.status, 200,
      'the state is computed from the row, so a server that was off does not over-serve the sentence');

    // And they are findable again. Searched by name, since email matching is
    // exact and a local part on its own is deliberately not a match.
    const other = await signUp(srv.base, 'Bystander Three', 'bystander3@susp.test');
    const found = await other.client.get('/api/users?q=lapse');
    assert.ok(found.body.users.some((u) => u.id === user.user.id));
  });

  test('a lapsed suspension is not in the dashboard list', async () => {
    const { boss, user } = await pair('gone');
    await boss.client.post(`/api/admin/users/${user.user.id}/suspension`, { days: 1 });
    assert.ok((await boss.client.get('/api/admin/suspended')).body.suspended
      .some((s) => s.id === user.user.id), 'precondition: listed');

    db.handle().prepare('UPDATE users SET suspended_until = ? WHERE id = ?')
      .run(Date.now() - 1000, user.user.id);

    const after = await boss.client.get('/api/admin/suspended');
    assert.ok(!after.body.suspended.some((s) => s.id === user.user.id));
    // Counted the same way the list is filtered, so the two cannot disagree.
    assert.equal(
      (await boss.client.get('/api/admin/overview')).body.accounts.suspended,
      after.body.suspended.length,
    );
  });
});

describe('who may suspend whom', () => {
  test('an ordinary account cannot, and the refusal admits nothing', async () => {
    const { user, boss } = await pair('nope');
    const control = await user.client.get('/api/no-such-endpoint');

    const res = await user.client.post(`/api/admin/users/${boss.user.id}/suspension`, { days: 7 });
    assert.equal(res.status, 404);
    assert.deepEqual(res.body, control.body);
    assert.equal(rowFor(boss.user.id).suspended_at, null);

    assert.equal((await user.client.get('/api/admin/suspended')).status, 404);
    assert.equal((await user.client.del(`/api/admin/users/${boss.user.id}/suspension`)).status, 404);
  });

  test('a signed-out caller cannot either', async () => {
    const { user } = await pair('anon');
    const anon = client(srv.base);
    assert.equal((await anon.post(`/api/admin/users/${user.user.id}/suspension`, { days: 7 })).status, 404);
    assert.equal(rowFor(user.user.id).suspended_at, null);
  });

  test('an administrator cannot suspend themselves', async () => {
    const { boss } = await pair('self');
    const res = await boss.client.post(`/api/admin/users/${boss.user.id}/suspension`, { days: 7 });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /your own account/);
    // Because the tool that undoes it is the one they would be locked out of.
    assert.equal((await boss.client.get('/api/admin/overview')).status, 200);
  });

  test('one administrator cannot suspend another', async () => {
    const { boss } = await pair('coup');
    const other = await signUp(srv.base, 'Other Boss', 'otherboss@susp.test');
    makeAdmin(other.user.id);

    const res = await boss.client.post(`/api/admin/users/${other.user.id}/suspension`, { days: 7 });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /npm run admin/, 'it points at the shell, which is the higher bar');
    assert.equal(rowFor(other.user.id).suspended_at, null);
    assert.equal((await other.client.get('/api/admin/overview')).status, 200);
  });

  test('suspending somebody who does not exist is a 404', async () => {
    const { boss } = await pair('ghost');
    assert.equal((await boss.client.post('/api/admin/users/u-nobody/suspension', { days: 7 })).status, 404);
  });

  test('a nonsense duration is refused rather than guessed at', async () => {
    const { boss, user } = await pair('duration');
    // `true` and `[7]` are here on purpose: Number() would take them for 1 and 7.
    for (const days of [0, -5, 'soon', 99999, 1e308, true, false, {}, [7], [], '7 days']) {
      const res = await boss.client.post(`/api/admin/users/${user.user.id}/suspension`, { days });
      assert.equal(res.status, 400, `${JSON.stringify(days)} must be refused`);
    }
    assert.equal(rowFor(user.user.id).suspended_at, null, 'and none of them took effect');
  });

  test('everything that means "no end date" is treated the same way', async () => {
    // Absent, null, "" and " " all mean open-ended — the form's "until someone
    // lifts it" option submits an empty value. Infinity and NaN land here too:
    // JSON cannot carry either, so JSON.stringify turns both into null. Worth
    // pinning, because a reader could reasonably expect some of these to be 400s.
    for (const [i, days] of [undefined, null, '', '  ', Infinity, NaN].entries()) {
      const { boss, user } = await pair(`open${i}`);
      const res = await boss.client.post(
        `/api/admin/users/${user.user.id}/suspension`,
        days === undefined ? {} : { days },
      );
      assert.equal(res.status, 200, `${JSON.stringify(days)} must be accepted`);
      assert.equal(res.body.until, null);
      assert.equal(rowFor(user.user.id).suspended_until, null);
      assert.ok(rowFor(user.user.id).suspended_at, 'and it did take effect');
    }
  });
});

describe('the record', () => {
  test('suspending and lifting are both audited, with the reason and the length', async () => {
    const { boss, user } = await pair('audit');
    db.handle().prepare('DELETE FROM admin_audit').run();

    await boss.client.post(`/api/admin/users/${user.user.id}/suspension`, {
      days: 30, reason: 'Impersonating support.',
    });
    await boss.client.del(`/api/admin/users/${user.user.id}/suspension`);

    const rows = db.handle().prepare('SELECT * FROM admin_audit ORDER BY at').all()
      .filter((r) => r.action.startsWith('user.'));
    assert.equal(rows.length, 2);

    assert.equal(rows[0].action, 'user.suspend');
    assert.equal(rows[0].actor_id, boss.user.id);
    assert.equal(rows[0].target_id, user.user.id);
    assert.match(rows[0].detail, /30 day/);
    assert.match(rows[0].detail, /Impersonating support\./);

    assert.equal(rows[1].action, 'user.unsuspend');
    assert.equal(rows[1].target_id, user.user.id);
  });

  test('the dashboard shows who did it, when, and until when', async () => {
    const { boss, user } = await pair('shown');
    await boss.client.post(`/api/admin/users/${user.user.id}/suspension`, {
      days: 7, reason: 'Two warnings already.',
    });

    const res = await boss.client.get('/api/admin/suspended');
    const entry = res.body.suspended.find((s) => s.id === user.user.id);
    assert.ok(entry);
    assert.equal(entry.reason, 'Two warnings already.');
    assert.equal(entry.by, 'Boss shown');
    assert.ok(entry.until > Date.now());
    assert.equal(entry.username, user.user.username);
  });

  test('a report card knows the subject is already suspended', async () => {
    const { boss, user } = await pair('card');
    const reporter = await signUp(srv.base, 'Card Reporter', 'cardreporter@susp.test');
    await reporter.client.post('/api/reports', { subjectId: user.user.id, reason: 'spam' });

    const before = await boss.client.get('/api/admin/reports');
    assert.equal(before.body.reports.find((r) => r.subject?.id === user.user.id).subject.suspended, false);

    await boss.client.post(`/api/admin/users/${user.user.id}/suspension`, { days: 7 });

    const after = await boss.client.get('/api/admin/reports');
    assert.equal(after.body.reports.find((r) => r.subject?.id === user.user.id).subject.suspended, true,
      'so the card offers Suspend once, not every time it is read');
  });
});

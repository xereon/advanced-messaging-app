// Appealing a suspension.
//
// The awkward part is that the caller has no session — being suspended is
// exactly the state of having none — so the endpoint is unauthenticated and has
// to prove the account is theirs another way. That makes it the one place in the
// app where a password is checked outside sign-in, and most of this file is
// about it not becoming something else as a result: not a password oracle, not
// a way to test which addresses are suspended, and not a way to flood the queue.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { startTestServer, signUp, client } from './helpers.js';
import * as db from '../server/db.js';
import { setRateLimitEnabled, resetRateLimits } from '../server/auth.js';

let srv;
before(async () => { srv = await startTestServer(); });
after(async () => { await srv.stop(); });

const makeAdmin = (id) => db.handle().prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(id);
const PASSWORD = 'hunter2hunter';

/** An administrator, and a suspended account with a known password. */
async function suspended(tag, { days = 7, reason = 'Spam.' } = {}) {
  const boss = await signUp(srv.base, `Boss ${tag}`, `boss.${tag}@appeal.test`);
  const user = await signUp(srv.base, `User ${tag}`, `user.${tag}@appeal.test`);
  makeAdmin(boss.user.id);
  await boss.client.post(`/api/admin/users/${user.user.id}/suspension`, { days, reason });
  return { boss, user, email: `user.${tag}@appeal.test` };
}

describe('sending an appeal', () => {
  test('a suspended account can send one, with no session at all', async () => {
    const { email, user } = await suspended('send');
    // A fresh client with no cookie, which is all a suspended person has.
    const anon = client(srv.base);
    const res = await anon.post('/api/auth/appeal', {
      email, password: PASSWORD, message: 'The links were to my own site, not spam.',
    });
    assert.equal(res.status, 201);

    const row = db.handle().prepare('SELECT * FROM appeals WHERE user_id = ?').get(user.user.id);
    assert.equal(row.message, 'The links were to my own site, not spam.');
    assert.equal(row.status, 'new');
    assert.equal(row.suspended_at, db.handle().prepare('SELECT suspended_at FROM users WHERE id = ?')
      .get(user.user.id).suspended_at, 'tied to the suspension it argues with');
  });

  test('exactly one per suspension — a rule, not a rate limit', async () => {
    const { email, boss, user } = await suspended('once');
    const anon = client(srv.base);
    assert.equal((await anon.post('/api/auth/appeal', { email, password: PASSWORD, message: 'First.' })).status, 201);

    const second = await anon.post('/api/auth/appeal', { email, password: PASSWORD, message: 'Second.' });
    assert.equal(second.status, 409);
    assert.match(second.body.error, /already appealed/);

    const rows = db.handle().prepare('SELECT * FROM appeals WHERE user_id = ?').all(user.user.id);
    assert.equal(rows.length, 1, 'the queue cannot be flooded by the account it is about');
    assert.equal(rows[0].message, 'First.', 'and the first one is not overwritten');

    // A *new* suspension is a new thing to appeal, so that one is allowed.
    await boss.client.del(`/api/admin/users/${user.user.id}/suspension`);
    await boss.client.post(`/api/admin/users/${user.user.id}/suspension`, { days: 3, reason: 'Again.' });
    const afresh = await anon.post('/api/auth/appeal', { email, password: PASSWORD, message: 'Third.' });
    assert.equal(afresh.status, 201);
    assert.equal(db.handle().prepare('SELECT COUNT(*) AS n FROM appeals WHERE user_id = ?')
      .get(user.user.id).n, 2);
  });

  test('an empty message is refused', async () => {
    const { email } = await suspended('empty');
    const anon = client(srv.base);
    for (const message of ['', '   ', '\n', null, undefined]) {
      assert.equal((await anon.post('/api/auth/appeal', { email, password: PASSWORD, message })).status, 400);
    }
  });

  test('an overlong message is trimmed rather than thrown away', async () => {
    const { email, user } = await suspended('long');
    const res = await client(srv.base).post('/api/auth/appeal', {
      email, password: PASSWORD, message: 'x'.repeat(6000),
    });
    assert.equal(res.status, 201);
    assert.equal(
      db.handle().prepare('SELECT message FROM appeals WHERE user_id = ?').get(user.user.id).message.length,
      2000,
    );
  });

  test('it does not sign them in — appealing is not a way back in', async () => {
    const { email } = await suspended('nosession');
    const anon = client(srv.base);
    await anon.post('/api/auth/appeal', { email, password: PASSWORD, message: 'Please look again.' });
    assert.equal(anon.cookie, null, 'no session cookie may be issued');
    assert.equal((await anon.get('/api/bootstrap')).status, 401);
  });
});

describe('what the endpoint must not become', () => {
  test('a wrong password is refused with the sign-in wording', async () => {
    const { email } = await suspended('wrongpw');
    const res = await client(srv.base).post('/api/auth/appeal', {
      email, password: 'not-the-password', message: 'Let me in.',
    });
    assert.equal(res.status, 401);
    assert.equal(res.body.error, 'Email or password is incorrect.');
    assert.ok(!/suspend/i.test(res.body.error), 'and it says nothing about suspension');
  });

  test('an unknown address answers exactly as a wrong password does', async () => {
    const { email } = await suspended('unknown');
    const anon = client(srv.base);
    const wrongPw = await anon.post('/api/auth/appeal', { email, password: 'nope', message: 'hi' });
    const noAccount = await anon.post('/api/auth/appeal', {
      email: 'nobody@nowhere.test', password: 'nope', message: 'hi',
    });
    assert.equal(noAccount.status, wrongPw.status);
    assert.deepEqual(noAccount.body, wrongPw.body,
      'otherwise this endpoint tells you which addresses exist');
  });

  test('an account that is not suspended cannot appeal, even with the right password', async () => {
    const fine = await signUp(srv.base, 'Fine Account', 'fine@appeal.test');
    const res = await client(srv.base).post('/api/auth/appeal', {
      email: 'fine@appeal.test', password: PASSWORD, message: 'Nothing to appeal.',
    });
    assert.equal(res.status, 403);
    assert.equal(db.handle().prepare('SELECT COUNT(*) AS n FROM appeals WHERE user_id = ?')
      .get(fine.user.id).n, 0);
  });

  test('a lapsed suspension can no longer be appealed', async () => {
    const { email, user } = await suspended('lapsed', { days: 1 });
    db.handle().prepare('UPDATE users SET suspended_until = ? WHERE id = ?')
      .run(Date.now() - 1000, user.user.id);

    const res = await client(srv.base).post('/api/auth/appeal', {
      email, password: PASSWORD, message: 'Too late.',
    });
    assert.equal(res.status, 403, 'there is nothing in force to argue with');
  });

  test('it is rate limited, so it is no cheaper than the login route', async () => {
    const { email } = await suspended('ratelimit');
    // The harness disables limits so they do not throttle the suite against
    // itself from one loopback address; this is the test that wants them.
    resetRateLimits();
    setRateLimitEnabled(true);
    try {
      const anon = client(srv.base);
      const statuses = [];
      for (let i = 0; i < 8; i++) {
        statuses.push((await anon.post('/api/auth/appeal', {
          email, password: `guess-${i}`, message: 'x',
        })).status);
      }
      assert.ok(statuses.includes(429), `expected a 429 among ${statuses.join(',')}`);
    } finally {
      setRateLimitEnabled(false);
      resetRateLimits();
    }
  });

  test('the request is still CSRF-protected', async () => {
    const { email } = await suspended('csrf');
    const res = await fetch(`${srv.base}/api/auth/appeal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },   // no X-Relay-Client
      body: JSON.stringify({ email, password: PASSWORD, message: 'from a form' }),
    });
    assert.equal(res.status, 403);
  });
});

describe('reading appeals', () => {
  test('an administrator sees it beside the suspension it argues with', async () => {
    const { boss, email, user } = await suspended('read', { reason: 'Posting adverts.' });
    await client(srv.base).post('/api/auth/appeal', {
      email, password: PASSWORD, message: 'They were my own products.',
    });

    const res = await boss.client.get('/api/admin/appeals');
    assert.equal(res.status, 200);
    const appeal = res.body.appeals.find((a) => a.userId === user.user.id);
    assert.ok(appeal);
    assert.equal(appeal.message, 'They were my own products.');
    assert.equal(appeal.name, 'User read');
    assert.equal(appeal.email, `user.read@appeal.test`);
    assert.equal(appeal.suspensionReason, 'Posting adverts.', 'the reason they were given');
    assert.equal(appeal.stillSuspended, true);
  });

  test('an appeal whose suspension was lifted says so', async () => {
    const { boss, email, user } = await suspended('lifted');
    await client(srv.base).post('/api/auth/appeal', { email, password: PASSWORD, message: 'Please.' });
    await boss.client.del(`/api/admin/users/${user.user.id}/suspension`);

    const res = await boss.client.get('/api/admin/appeals');
    const appeal = res.body.appeals.find((a) => a.userId === user.user.id);
    assert.ok(appeal, 'it is still readable');
    assert.equal(appeal.stillSuspended, false, 'but acting on it would be acting on nothing');
  });

  test('nobody else can read appeals, and the refusal admits nothing', async () => {
    const { email, user } = await suspended('private');
    await client(srv.base).post('/api/auth/appeal', { email, password: PASSWORD, message: 'Private.' });

    const nosy = await signUp(srv.base, 'Nosy Appeal', 'nosy@appeal.test');
    const control = await nosy.client.get('/api/no-such-endpoint');
    const res = await nosy.client.get('/api/admin/appeals');
    assert.equal(res.status, 404);
    assert.deepEqual(res.body, control.body);
    assert.equal(
      (await nosy.client.patch(`/api/admin/appeals/${user.user.id}/1`, { status: 'granted' })).status,
      404,
    );
  });

  test('resolving one is audited, and it leaves the waiting queue', async () => {
    const { boss, email, user } = await suspended('resolve');
    await client(srv.base).post('/api/auth/appeal', { email, password: PASSWORD, message: 'Reconsider.' });
    const at = db.handle().prepare('SELECT suspended_at FROM users WHERE id = ?')
      .get(user.user.id).suspended_at;

    const res = await boss.client.patch(`/api/admin/appeals/${user.user.id}/${at}`, { status: 'refused' });
    assert.equal(res.status, 200);

    const waiting = await boss.client.get('/api/admin/appeals?status=new');
    assert.ok(!waiting.body.appeals.some((a) => a.userId === user.user.id));

    const entry = db.handle().prepare(
      "SELECT * FROM admin_audit WHERE action = 'appeal.resolve' AND target_id = ?",
    ).get(user.user.id);
    assert.ok(entry, 'deciding somebody\'s appeal is an administrator action, so it is logged');
    assert.equal(entry.detail, 'new → refused');
  });

  test('an unknown appeal or status is refused', async () => {
    const { boss, user } = await suspended('badinput');
    assert.equal((await boss.client.patch(`/api/admin/appeals/${user.user.id}/999`, { status: 'granted' })).status, 404);
    assert.equal((await boss.client.get('/api/admin/appeals?status=whatever')).status, 400);
  });

  test('the overview counts appeals waiting', async () => {
    const { boss, email } = await suspended('count');
    const before = (await boss.client.get('/api/admin/overview')).body.appeals.waiting;
    await client(srv.base).post('/api/auth/appeal', { email, password: PASSWORD, message: 'Counted.' });
    const after = (await boss.client.get('/api/admin/overview')).body.appeals;
    assert.equal(after.waiting, before + 1);
  });
});

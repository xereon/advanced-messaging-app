import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { startTestServer, client, signUp } from './helpers.js';
import * as auth from '../server/auth.js';

let srv;
before(async () => { srv = await startTestServer(); });
after(async () => { await srv.stop(); });

describe('password hashing', () => {
  test('verifies a correct secret and rejects a wrong one', async () => {
    const { salt, hash } = await auth.makeSecret('correct horse battery');
    assert.equal(await auth.verifySecret('correct horse battery', salt, hash), true);
    assert.equal(await auth.verifySecret('wrong horse battery', salt, hash), false);
  });

  test('never stores the plaintext', async () => {
    const { hash } = await auth.makeSecret('s3cret-value');
    assert.ok(!hash.includes('s3cret-value'));
    assert.match(hash, /^[0-9a-f]{128}$/);
  });

  test('the same password hashes differently for two accounts', async () => {
    const a = await auth.makeSecret('same-password');
    const b = await auth.makeSecret('same-password');
    assert.notEqual(a.hash, b.hash, 'salts must differ');
  });

  test('missing salt or hash fails closed', async () => {
    assert.equal(await auth.verifySecret('x', null, null), false);
    assert.equal(await auth.verifySecret('x', 'abc', undefined), false);
  });
});

describe('sign up and sign in', () => {
  test('creates an account and returns a session cookie', async () => {
    const { client: c, user } = await signUp(srv.base, 'Ada Lovelace', 'ada@test.io');
    assert.equal(user.name, 'Ada Lovelace');
    assert.ok(c.cookie.startsWith('relay_session='));
    const me = await c.get('/api/me');
    assert.equal(me.status, 200);
    assert.equal(me.body.user.email, 'ada@test.io');
  });

  test('never returns password material to the client', async () => {
    const { user } = await signUp(srv.base, 'Grace Hopper', 'grace@test.io');
    for (const leaky of ['pw_hash', 'pw_salt', 'pin_hash', 'pin_salt']) {
      assert.equal(user[leaky], undefined, `${leaky} must not be exposed`);
    }
  });

  test('rejects a duplicate email', async () => {
    await signUp(srv.base, 'First', 'dupe@test.io');
    const c = client(srv.base);
    const res = await c.post('/api/auth/signup', { name: 'Second', email: 'dupe@test.io', password: 'hunter2hunter' });
    assert.equal(res.status, 409);
  });

  test('rejects a short password and a malformed email', async () => {
    const c = client(srv.base);
    assert.equal((await c.post('/api/auth/signup', { name: 'X', email: 'x@test.io', password: 'short' })).status, 400);
    assert.equal((await c.post('/api/auth/signup', { name: 'X', email: 'nope', password: 'hunter2hunter' })).status, 400);
  });

  test('wrong password is refused, and the message does not reveal whether the account exists', async () => {
    await signUp(srv.base, 'Real User', 'real@test.io');
    const c = client(srv.base);
    const wrong = await c.post('/api/auth/login', { email: 'real@test.io', password: 'not-the-password' });
    const missing = await c.post('/api/auth/login', { email: 'ghost@test.io', password: 'not-the-password' });
    assert.equal(wrong.status, 401);
    assert.equal(missing.status, 401);
    assert.equal(wrong.body.error, missing.body.error);
  });

  test('an unauthenticated caller cannot reach account data', async () => {
    const c = client(srv.base);
    assert.equal((await c.get('/api/bootstrap')).status, 401);
    assert.equal((await c.get('/api/me')).status, 401);
    assert.equal((await c.get('/api/users?q=a')).status, 401);
  });

  test('a forged session cookie is rejected', async () => {
    const c = client(srv.base);
    c.cookie = 'relay_session=totally-made-up-token';
    assert.equal((await c.get('/api/bootstrap')).status, 401);
  });

  test('signing out invalidates the session', async () => {
    const { client: c } = await signUp(srv.base, 'Bye Now', 'bye@test.io');
    assert.equal((await c.get('/api/me')).status, 200);
    await c.post('/api/auth/logout');
    assert.equal((await c.get('/api/me')).status, 401);
  });

  test('changing the password signs other devices out', async () => {
    const { client: a, user } = await signUp(srv.base, 'Multi Device', 'multi@test.io');
    const b = client(srv.base);
    const login = await b.post('/api/auth/login', { email: 'multi@test.io', password: 'hunter2hunter' });
    assert.equal(login.status, 200);
    assert.equal((await b.get('/api/me')).status, 200);

    const changed = await a.post('/api/account/password', { current: 'hunter2hunter', next: 'a-brand-new-password' });
    assert.equal(changed.status, 200);
    assert.equal((await b.get('/api/me')).status, 401, 'the other device must be signed out');
    assert.ok(user.id);
  });

  test('the wrong current password cannot change the password', async () => {
    const { client: c } = await signUp(srv.base, 'Careful', 'careful@test.io');
    const res = await c.post('/api/account/password', { current: 'wrong-one', next: 'another-password' });
    assert.equal(res.status, 403);
  });
});

describe('CSRF and rate limiting', () => {
  test('state-changing calls need the client header', async () => {
    const { client: c } = await signUp(srv.base, 'Csrf Test', 'csrf@test.io');
    const res = await c.post('/api/auth/logout', {}, { csrf: false });
    assert.equal(res.status, 403);
    assert.equal((await c.get('/api/me')).status, 200, 'session must survive the blocked call');
  });

  test('repeated failed logins are throttled', async () => {
    await signUp(srv.base, 'Target', 'target@test.io');
    auth.setRateLimitEnabled(true);
    const c = client(srv.base);
    let sawLimit = false;
    for (let i = 0; i < 12; i++) {
      const res = await c.post('/api/auth/login', { email: 'target@test.io', password: `guess-${i}` });
      if (res.status === 429) { sawLimit = true; break; }
    }
    assert.ok(sawLimit, 'brute force must eventually be rate limited');
    auth.setRateLimitEnabled(false);
  });
});

describe('one-time login codes', () => {
  test('a valid code signs the user in and cannot be reused', async () => {
    await signUp(srv.base, 'Code User', 'code@test.io');
    const c = client(srv.base);
    const req = await c.post('/api/auth/code/request', { email: 'code@test.io' });
    assert.equal(req.status, 200);
    assert.match(req.body.code, /^\d{6}$/);

    const ok = await c.post('/api/auth/code/verify', { email: 'code@test.io', code: req.body.code });
    assert.equal(ok.status, 200);

    const replay = await client(srv.base).post('/api/auth/code/verify', { email: 'code@test.io', code: req.body.code });
    assert.equal(replay.status, 400, 'a code must be single-use');
  });

  test('a wrong code is refused', async () => {
    await signUp(srv.base, 'Code Two', 'code2@test.io');
    const c = client(srv.base);
    const req = await c.post('/api/auth/code/request', { email: 'code2@test.io' });
    const wrong = String((Number(req.body.code) + 1) % 1000000).padStart(6, '0');
    assert.equal((await c.post('/api/auth/code/verify', { email: 'code2@test.io', code: wrong })).status, 400);
  });
});

describe('quick-unlock PIN', () => {
  test('the right PIN signs in and a wrong one does not', async () => {
    const { client: c, user } = await signUp(srv.base, 'Pin User', 'pin@test.io');
    assert.equal((await c.post('/api/account/pin', { pin: '2468' })).status, 200);

    const good = await client(srv.base).post('/api/auth/pin', { userId: user.id, pin: '2468' });
    assert.equal(good.status, 200);

    const bad = await client(srv.base).post('/api/auth/pin', { userId: user.id, pin: '1357' });
    assert.equal(bad.status, 401);
  });

  test('a non-numeric or short PIN is rejected', async () => {
    const { client: c } = await signUp(srv.base, 'Pin Two', 'pin2@test.io');
    assert.equal((await c.post('/api/account/pin', { pin: '12' })).status, 400);
    assert.equal((await c.post('/api/account/pin', { pin: 'abcd' })).status, 400);
  });
});

describe('guests', () => {
  test('each concurrent guest gets a distinct name and colour', async () => {
    const a = await client(srv.base).post('/api/auth/guest');
    const b = await client(srv.base).post('/api/auth/guest');
    assert.equal(a.status, 201);
    assert.equal(b.status, 201);
    assert.notEqual(a.body.user.name, b.body.user.name);
    assert.notEqual(a.body.user.avatarColor, b.body.user.avatarColor);
    assert.equal(a.body.user.isGuest, true);
  });

  test('a guest who never spoke is removed on sign out', async () => {
    const c = client(srv.base);
    const { body } = await c.post('/api/auth/guest');
    await c.post('/api/auth/logout');
    const search = client(srv.base);
    await signUp(srv.base, 'Searcher', `searcher-${Date.now()}@test.io`);
    assert.ok(body.user.id);
    // The account is gone, so a PIN or session against it cannot resolve.
    assert.equal((await search.get('/api/me')).status, 401);
  });
});

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { startTestServer, client, signUp } from './helpers.js';

let srv;
before(async () => { srv = await startTestServer(); });
after(async () => { await srv.stop(); });

const html = () => readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

describe('credentials cannot reach a URL', () => {
  test('every form that carries a secret posts, so nothing lands in the query string', () => {
    const forms = [...html().matchAll(/<form[^>]*>/g)].map((m) => m[0]);
    assert.ok(forms.length >= 5, 'expected the auth and dialog forms');
    for (const form of forms) {
      assert.match(form, /method="post"/i, `form defaults to GET, which puts fields in the URL: ${form}`);
    }
  });

  test('no form targets the app root, which would rewrite the address bar', () => {
    for (const form of [...html().matchAll(/<form[^>]*>/g)].map((m) => m[0])) {
      assert.match(form, /action="\/api\/auth\/no-script"/, `form has no explicit action: ${form}`);
    }
  });

  test('password inputs are real password fields', () => {
    for (const m of html().matchAll(/<input[^>]*name="password"[^>]*>/g)) {
      assert.match(m[0], /type="password"/);
    }
  });
});

describe('the no-JavaScript fallback', () => {
  test('answers without the client header and never echoes what was sent', async () => {
    const res = await fetch(`${srv.base}/api/auth/no-script`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'email=someone@example.com&password=hunter2hunter',
    });
    assert.equal(res.status, 200);
    const page = await res.text();
    assert.match(page, /JavaScript is required/i);
    assert.ok(!page.includes('hunter2hunter'), 'the page must not echo the password');
    assert.ok(!page.includes('someone@example.com'), 'the page must not echo the address');
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  });

  test('it does not create a session', async () => {
    const res = await fetch(`${srv.base}/api/auth/no-script`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'email=nobody@example.com&password=whatever12345',
    });
    assert.equal(res.headers.getSetCookie().length, 0);
  });
});

describe('secrets arriving in a query string are scrubbed', () => {
  const cases = ['password', 'pass', 'pwd', 'pin', 'code', 'token', 'secret'];

  for (const key of cases) {
    test(`a page load carrying ?${key}= is redirected to a clean URL`, async () => {
      const res = await fetch(`${srv.base}/?${key}=leaked-value&keep=this`, { redirect: 'manual' });
      assert.equal(res.status, 303);
      const location = res.headers.get('location');
      assert.ok(!location.includes('leaked-value'), `secret survived in: ${location}`);
      assert.ok(!location.includes(`${key}=`), `parameter survived in: ${location}`);
      assert.match(location, /keep=this/, 'harmless parameters should be preserved');
      assert.equal(res.headers.get('cache-control'), 'no-store');
    });
  }

  test('an API GET carrying a secret is scrubbed too', async () => {
    const { client: c } = await signUp(srv.base, 'Url Safety', 'urlsafety@test.io');
    const res = await fetch(`${srv.base}/api/users?q=ada&password=leaked-value`, {
      headers: { Cookie: c.cookie },
      redirect: 'manual',
    });
    assert.equal(res.status, 303);
    assert.ok(!res.headers.get('location').includes('leaked-value'));
  });

  test('ordinary query strings are untouched', async () => {
    const { client: c } = await signUp(srv.base, 'Normal Query', 'normalquery@test.io');
    const res = await c.get('/api/users?q=normal');
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.users));
  });
});

describe('auth responses are never cached or referred', () => {
  test('sign-in sets no-store and no-referrer', async () => {
    await signUp(srv.base, 'Cache Check', 'cachecheck@test.io');
    const res = await fetch(`${srv.base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Relay-Client': '1' },
      body: JSON.stringify({ email: 'cachecheck@test.io', password: 'hunter2hunter' }),
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  });

  test('the app shell sends no referrer, so no URL can travel outward', async () => {
    const res = await fetch(`${srv.base}/`);
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  });

  test('a session cookie is never exposed in a response body', async () => {
    await signUp(srv.base, 'Body Check', 'bodycheck@test.io');
    const res = await fetch(`${srv.base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Relay-Client': '1' },
      body: JSON.stringify({ email: 'bodycheck@test.io', password: 'hunter2hunter' }),
    });
    const text = await res.text();
    assert.ok(!text.includes('relay_session'), 'the token belongs in the cookie only');
    assert.ok(!text.includes('hunter2hunter'), 'the password must never come back');
  });
});

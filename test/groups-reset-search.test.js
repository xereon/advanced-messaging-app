import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { startTestServer, client, signUp } from './helpers.js';
import { setRateLimitEnabled } from '../server/auth.js';

let srv;
before(async () => { srv = await startTestServer(); });
after(async () => { await srv.stop(); });

async function group(tag, extra = 0) {
  const owner = await signUp(srv.base, `Owner ${tag}`, `owner-${tag}@grp.test`);
  const member = await signUp(srv.base, `Member ${tag}`, `member-${tag}@grp.test`);
  const others = [];
  for (let i = 0; i < extra; i++) {
    others.push(await signUp(srv.base, `Extra ${tag}${i}`, `extra-${tag}${i}@grp.test`));
  }
  const { body } = await owner.client.post('/api/conversations', {
    type: 'group', title: `Team ${tag}`, members: [member.user.id],
  });
  return { owner, member, others, convo: body.conversation };
}

describe('password reset', () => {
  test('a code resets the password and signs you in', async () => {
    await signUp(srv.base, 'Forgetful', 'forgetful@reset.test');
    const c = client(srv.base);

    const req = await c.post('/api/auth/reset/request', { email: 'forgetful@reset.test' });
    assert.equal(req.status, 200);
    assert.match(req.body.code, /^\d{6}$/);

    const done = await c.post('/api/auth/reset/confirm', {
      email: 'forgetful@reset.test', code: req.body.code, password: 'a-brand-new-password',
    });
    assert.equal(done.status, 200);
    assert.equal((await c.get('/api/me')).status, 200, 'the reset signs you straight in');

    // The new password works and the old one does not.
    const fresh = client(srv.base);
    assert.equal((await fresh.post('/api/auth/login', { email: 'forgetful@reset.test', password: 'a-brand-new-password' })).status, 200);
    const old = client(srv.base);
    assert.equal((await old.post('/api/auth/login', { email: 'forgetful@reset.test', password: 'hunter2hunter' })).status, 401);
  });

  test('resetting signs every other device out', async () => {
    await signUp(srv.base, 'Multi Reset', 'multireset@reset.test');
    const elsewhere = client(srv.base);
    await elsewhere.post('/api/auth/login', { email: 'multireset@reset.test', password: 'hunter2hunter' });
    assert.equal((await elsewhere.get('/api/me')).status, 200);

    const c = client(srv.base);
    const req = await c.post('/api/auth/reset/request', { email: 'multireset@reset.test' });
    await c.post('/api/auth/reset/confirm', { email: 'multireset@reset.test', code: req.body.code, password: 'another-new-password' });

    assert.equal((await elsewhere.get('/api/me')).status, 401, 'the other session must be gone');
  });

  test('an unknown address answers the same way, revealing nothing', async () => {
    const c = client(srv.base);
    const res = await c.post('/api/auth/reset/request', { email: 'nobody@nowhere.test' });
    assert.equal(res.status, 200);
    assert.equal(res.body.code, undefined, 'no code for an address with no account');
    assert.equal(res.body.delivery, 'sent-if-registered');
  });

  test('a wrong code is refused, and a code is single-use', async () => {
    await signUp(srv.base, 'Careful Reset', 'carefulreset@reset.test');
    const c = client(srv.base);
    const req = await c.post('/api/auth/reset/request', { email: 'carefulreset@reset.test' });
    const wrong = String((Number(req.body.code) + 1) % 1000000).padStart(6, '0');

    assert.equal((await c.post('/api/auth/reset/confirm', { email: 'carefulreset@reset.test', code: wrong, password: 'nope-nope-nope' })).status, 400);

    const ok = await c.post('/api/auth/reset/confirm', { email: 'carefulreset@reset.test', code: req.body.code, password: 'fresh-password-1' });
    assert.equal(ok.status, 200);

    const replay = client(srv.base);
    assert.equal((await replay.post('/api/auth/reset/confirm', { email: 'carefulreset@reset.test', code: req.body.code, password: 'fresh-password-2' })).status, 400);
  });

  test('a short new password is refused', async () => {
    await signUp(srv.base, 'Short Reset', 'shortreset@reset.test');
    const c = client(srv.base);
    const req = await c.post('/api/auth/reset/request', { email: 'shortreset@reset.test' });
    assert.equal((await c.post('/api/auth/reset/confirm', { email: 'shortreset@reset.test', code: req.body.code, password: 'short' })).status, 400);
  });

  test('repeated guesses are throttled', async () => {
    await signUp(srv.base, 'Bruteforced', 'brute@reset.test');
    const c = client(srv.base);
    await c.post('/api/auth/reset/request', { email: 'brute@reset.test' });
    setRateLimitEnabled(true);
    let limited = false;
    for (let i = 0; i < 30; i++) {
      const res = await c.post('/api/auth/reset/confirm', { email: 'brute@reset.test', code: '000000', password: 'guessing-away' });
      if (res.status === 429) { limited = true; break; }
    }
    setRateLimitEnabled(false);
    assert.ok(limited, 'guessing must eventually be rate limited');
  });
});

describe('group management', () => {
  test('the group can be renamed, and everyone sees a note about it', async () => {
    const { owner, member, convo } = await group('rename');
    const res = await owner.client.patch(`/api/conversations/${encodeURIComponent(convo.id)}`, { title: 'Renamed Crew' });
    assert.equal(res.status, 200);
    assert.equal(res.body.conversation.title, 'Renamed Crew');

    const boot = await member.client.get('/api/bootstrap');
    const seen = boot.body.conversations.find((c) => c.id === convo.id);
    assert.equal(seen.title, 'Renamed Crew');
    const notes = boot.body.messages[convo.id].filter((m) => m.system);
    assert.ok(notes.some((m) => m.text.includes('Renamed Crew')));
  });

  test('an empty name is refused', async () => {
    const { owner, convo } = await group('emptyname');
    assert.equal((await owner.client.patch(`/api/conversations/${encodeURIComponent(convo.id)}`, { title: '  ' })).status, 400);
  });

  test('a member can be added and can then see the conversation', async () => {
    const { owner, convo } = await group('add');
    const newcomer = await signUp(srv.base, 'Newcomer', 'newcomer@grp.test');

    const res = await owner.client.post(`/api/conversations/${encodeURIComponent(convo.id)}/members`, { userId: newcomer.user.id });
    assert.equal(res.status, 200);
    assert.ok(res.body.conversation.members.includes(newcomer.user.id));

    const boot = await newcomer.client.get('/api/bootstrap');
    assert.ok(boot.body.conversations.some((c) => c.id === convo.id));
  });

  test('adding the same person twice is refused', async () => {
    const { owner, member, convo } = await group('dupe');
    const res = await owner.client.post(`/api/conversations/${encodeURIComponent(convo.id)}/members`, { userId: member.user.id });
    assert.equal(res.status, 400);
  });

  test('only the creator can remove someone else', async () => {
    const { owner, member, convo } = await group('perm');
    const third = await signUp(srv.base, 'Third Wheel', 'third@grp.test');
    await owner.client.post(`/api/conversations/${encodeURIComponent(convo.id)}/members`, { userId: third.user.id });

    // A plain member cannot evict another member.
    const denied = await member.client.del(`/api/conversations/${encodeURIComponent(convo.id)}/members/${third.user.id}`);
    assert.equal(denied.status, 403);

    const allowed = await owner.client.del(`/api/conversations/${encodeURIComponent(convo.id)}/members/${third.user.id}`);
    assert.equal(allowed.status, 200);
  });

  test('anyone can leave, and then loses access', async () => {
    const { member, convo } = await group('leave');
    const res = await member.client.del(`/api/conversations/${encodeURIComponent(convo.id)}/members/${member.user.id}`);
    assert.equal(res.status, 200);

    const boot = await member.client.get('/api/bootstrap');
    assert.ok(!boot.body.conversations.some((c) => c.id === convo.id), 'it should be gone from their list');
    assert.equal((await member.client.post(`/api/conversations/${encodeURIComponent(convo.id)}/messages`, { text: 'still here?' })).status, 403);
  });

  test('the conversation is deleted once the last person leaves', async () => {
    const { owner, member, convo } = await group('empty');
    await member.client.del(`/api/conversations/${encodeURIComponent(convo.id)}/members/${member.user.id}`);
    const last = await owner.client.del(`/api/conversations/${encodeURIComponent(convo.id)}/members/${owner.user.id}`);
    assert.equal(last.body.removed, true, 'the empty conversation should be cleaned up');
  });

  test('an outsider cannot touch the group at all', async () => {
    const { convo } = await group('outsider');
    const outsider = await signUp(srv.base, 'Group Outsider', 'groupoutsider@grp.test');
    const url = `/api/conversations/${encodeURIComponent(convo.id)}`;
    assert.equal((await outsider.client.patch(url, { title: 'Mine now' })).status, 403);
    assert.equal((await outsider.client.post(`${url}/members`, { userId: outsider.user.id })).status, 403);
  });

  test('these operations do not apply to a direct conversation', async () => {
    const a = await signUp(srv.base, 'Dm One', 'dmone@grp.test');
    const b = await signUp(srv.base, 'Dm Two', 'dmtwo@grp.test');
    const { body } = await a.client.post('/api/conversations', { type: 'dm', members: [b.user.id] });
    assert.equal((await a.client.patch(`/api/conversations/${encodeURIComponent(body.conversation.id)}`, { title: 'Nope' })).status, 400);
  });
});

describe('message search across full history', () => {
  test('it finds a message the client never loaded', async () => {
    const a = await signUp(srv.base, 'Search A', 'searcha@find.test');
    const b = await signUp(srv.base, 'Search B', 'searchb@find.test');
    const { body } = await a.client.post('/api/conversations', { type: 'dm', members: [b.user.id] });
    const url = `/api/conversations/${encodeURIComponent(body.conversation.id)}/messages`;

    await a.client.post(url, { text: 'the pelican memo is in the shared drive' });
    for (let i = 0; i < 30; i++) await a.client.post(url, { text: `filler ${i}` });

    const res = await b.client.get('/api/search/messages?q=pelican');
    assert.equal(res.status, 200);
    assert.equal(res.body.results.length, 1);
    assert.match(res.body.results[0].text, /pelican memo/);
    assert.equal(res.body.results[0].convoId, body.conversation.id);
  });

  test('it never reaches into a conversation you are not in', async () => {
    const a = await signUp(srv.base, 'Private A', 'privatea@find.test');
    const b = await signUp(srv.base, 'Private B', 'privateb@find.test');
    const { body } = await a.client.post('/api/conversations', { type: 'dm', members: [b.user.id] });
    await a.client.post(`/api/conversations/${encodeURIComponent(body.conversation.id)}/messages`,
      { text: 'confidential aardvark plans' });

    const outsider = await signUp(srv.base, 'Search Outsider', 'searchoutsider@find.test');
    const res = await outsider.client.get('/api/search/messages?q=aardvark');
    assert.deepEqual(res.body.results, []);
  });

  test('deleted messages and very short queries return nothing', async () => {
    const a = await signUp(srv.base, 'Deleter', 'deleter@find.test');
    const b = await signUp(srv.base, 'Deletee', 'deletee@find.test');
    const { body } = await a.client.post('/api/conversations', { type: 'dm', members: [b.user.id] });
    const sent = await a.client.post(`/api/conversations/${encodeURIComponent(body.conversation.id)}/messages`,
      { text: 'ephemeral wombat' });
    await a.client.del(`/api/messages/${sent.body.message.id}`);

    assert.deepEqual((await a.client.get('/api/search/messages?q=wombat')).body.results, []);
    assert.deepEqual((await a.client.get('/api/search/messages?q=a')).body.results, []);
  });

  test('search requires a session', async () => {
    const res = await fetch(`${srv.base}/api/search/messages?q=anything`);
    assert.equal(res.status, 401);
  });
});

describe('the app is installable and works offline', () => {
  const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

  test('the manifest describes a standalone app', () => {
    const manifest = JSON.parse(read('../public/manifest.webmanifest'));
    assert.equal(manifest.display, 'standalone');
    assert.equal(manifest.start_url, '/');
    assert.ok(manifest.icons.some((i) => i.purpose === 'maskable'), 'launchers crop non-maskable icons');
  });

  test('the page links the manifest and a service worker is registered', () => {
    assert.match(read('../public/index.html'), /rel="manifest"/);
    assert.match(read('../public/js/app.js'), /serviceWorker\.register\('\/sw\.js'\)/);
  });

  test('the service worker never caches the API', () => {
    const sw = read('../public/sw.js');
    assert.match(sw, /url\.pathname\.startsWith\('\/api\/'\)/,
      'a cached /api/bootstrap would show stale conversations as if they were live');
  });

  test('the manifest and worker are actually served', async () => {
    const manifest = await fetch(`${srv.base}/manifest.webmanifest`);
    assert.equal(manifest.status, 200);
    assert.match(manifest.headers.get('content-type'), /manifest\+json/);
    assert.equal((await fetch(`${srv.base}/sw.js`)).status, 200);
    assert.equal((await fetch(`${srv.base}/icon.svg`)).status, 200);
  });
});

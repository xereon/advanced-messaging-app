import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { startTestServer, client, signUp } from './helpers.js';

let srv;
before(async () => { srv = await startTestServer(); });
after(async () => { await srv.stop(); });

async function pair(tag) {
  const a = await signUp(srv.base, `A ${tag}`, `a-${tag}@test.io`);
  const b = await signUp(srv.base, `B ${tag}`, `b-${tag}@test.io`);
  const { body } = await a.client.post('/api/conversations', { type: 'dm', members: [b.user.id] });
  return { a, b, convo: body.conversation };
}

describe('conversations', () => {
  test('a new account is seeded with starter conversations', async () => {
    const { client: c } = await signUp(srv.base, 'Fresh Start', 'fresh@test.io');
    const { body } = await c.get('/api/bootstrap');
    assert.ok(body.conversations.length >= 3);
    assert.ok(body.conversations.some((x) => x.type === 'group'));
  });

  test('a direct conversation is reused rather than duplicated', async () => {
    const { a, b, convo } = await pair('reuse');
    const again = await a.client.post('/api/conversations', { type: 'dm', members: [b.user.id] });
    assert.equal(again.body.conversation.id, convo.id);
    // The far side gets the same id, whichever way round it is created.
    const fromB = await b.client.post('/api/conversations', { type: 'dm', members: [a.user.id] });
    assert.equal(fromB.body.conversation.id, convo.id);
  });

  test('a group needs a name and at least one other member', async () => {
    const { a, b } = await pair('group');
    assert.equal((await a.client.post('/api/conversations', { type: 'group', title: '', members: [b.user.id] })).status, 400);
    assert.equal((await a.client.post('/api/conversations', { type: 'group', title: 'Solo', members: [] })).status, 400);
    const ok = await a.client.post('/api/conversations', { type: 'group', title: 'Launch Team', members: [b.user.id] });
    assert.equal(ok.status, 201);
    assert.equal(ok.body.conversation.title, 'Launch Team');
  });
});

describe('messages', () => {
  test('a sent message is visible to the other member', async () => {
    const { a, b, convo } = await pair('send');
    const sent = await a.client.post(`/api/conversations/${encodeURIComponent(convo.id)}/messages`, { text: 'hello there' });
    assert.equal(sent.status, 201);

    const { body } = await b.client.get('/api/bootstrap');
    const texts = body.messages[convo.id].map((m) => m.text);
    assert.deepEqual(texts, ['hello there']);
  });

  test('empty and oversized messages are refused', async () => {
    const { a, convo } = await pair('bounds');
    const url = `/api/conversations/${encodeURIComponent(convo.id)}/messages`;
    assert.equal((await a.client.post(url, { text: '   ' })).status, 400);
    assert.equal((await a.client.post(url, { text: 'x'.repeat(4001) })).status, 400);
  });

  test('only the author can edit or delete', async () => {
    const { a, b, convo } = await pair('own');
    const { body } = await a.client.post(`/api/conversations/${encodeURIComponent(convo.id)}/messages`, { text: 'mine' });
    const id = body.message.id;

    assert.equal((await b.client.patch(`/api/messages/${id}`, { text: 'hijacked' })).status, 403);
    assert.equal((await b.client.del(`/api/messages/${id}`)).status, 403);

    const edited = await a.client.patch(`/api/messages/${id}`, { text: 'mine, edited' });
    assert.equal(edited.status, 200);
    assert.equal(edited.body.message.text, 'mine, edited');
    assert.ok(edited.body.message.editedAt);
  });

  test('a deleted message keeps no text on the server', async () => {
    const { a, b, convo } = await pair('delete');
    const { body } = await a.client.post(`/api/conversations/${encodeURIComponent(convo.id)}/messages`, { text: 'sensitive content' });
    await a.client.del(`/api/messages/${body.message.id}`);

    const boot = await b.client.get('/api/bootstrap');
    const msg = boot.body.messages[convo.id].find((m) => m.id === body.message.id);
    assert.ok(msg.deletedAt);
    assert.equal(msg.text, '');
  });

  test('replies must point at a message in the same conversation', async () => {
    const { a, convo } = await pair('reply');
    const other = await pair('reply-other');
    const foreign = await other.a.client.post(
      `/api/conversations/${encodeURIComponent(other.convo.id)}/messages`, { text: 'elsewhere' },
    );
    const res = await a.client.post(`/api/conversations/${encodeURIComponent(convo.id)}/messages`,
      { text: 'reply', replyTo: foreign.body.message.id });
    assert.equal(res.status, 400);
  });

  test('reactions toggle on and off', async () => {
    const { a, b, convo } = await pair('react');
    const { body } = await a.client.post(`/api/conversations/${encodeURIComponent(convo.id)}/messages`, { text: 'react to me' });
    const id = body.message.id;

    const on = await b.client.post(`/api/messages/${id}/reactions`, { emoji: '🎉' });
    assert.deepEqual(on.body.message.reactions['🎉'], [b.user.id]);

    const off = await b.client.post(`/api/messages/${id}/reactions`, { emoji: '🎉' });
    assert.equal(off.body.message.reactions['🎉'], undefined);
  });
});

describe('authorization', () => {
  test('an outsider cannot read, post to, or touch a conversation', async () => {
    const { a, convo } = await pair('outsider');
    const outsider = await signUp(srv.base, 'Nosy Parker', 'nosy@test.io');
    const url = `/api/conversations/${encodeURIComponent(convo.id)}`;

    assert.equal((await outsider.client.post(`${url}/messages`, { text: 'let me in' })).status, 403);
    assert.equal((await outsider.client.post(`${url}/read`, { at: Date.now() })).status, 403);
    assert.equal((await outsider.client.patch(`${url}/meta`, { pinned: true })).status, 403);
    assert.equal((await outsider.client.post(`${url}/typing`)).status, 403);

    const boot = await outsider.client.get('/api/bootstrap');
    assert.equal(boot.body.messages[convo.id], undefined, 'the conversation must not appear in their snapshot');
    assert.ok(a.user.id);
  });

  test('an outsider cannot react to a message they cannot see', async () => {
    const { a, convo } = await pair('react-auth');
    const { body } = await a.client.post(`/api/conversations/${encodeURIComponent(convo.id)}/messages`, { text: 'private' });
    const outsider = await signUp(srv.base, 'Also Nosy', 'nosy2@test.io');
    assert.equal((await outsider.client.post(`/api/messages/${body.message.id}/reactions`, { emoji: '👀' })).status, 403);
  });

  test('a conversation cannot be created on behalf of unknown people', async () => {
    const { client: c } = await signUp(srv.base, 'Inventor', 'inventor@test.io');
    const res = await c.post('/api/conversations', { type: 'dm', members: ['u-does-not-exist'] });
    assert.equal(res.status, 400);
  });
});

describe('read receipts', () => {
  test('a read is visible to the other member', async () => {
    const { a, b, convo } = await pair('reads');
    await a.client.post(`/api/conversations/${encodeURIComponent(convo.id)}/messages`, { text: 'did you see this' });
    const at = Date.now();
    await b.client.post(`/api/conversations/${encodeURIComponent(convo.id)}/read`, { at });

    const boot = await a.client.get('/api/bootstrap');
    assert.equal(boot.body.reads[convo.id][b.user.id], at);
  });

  test('a private read is hidden from others but kept for the reader', async () => {
    const { a, b, convo } = await pair('private-reads');
    await a.client.post(`/api/conversations/${encodeURIComponent(convo.id)}/messages`, { text: 'quietly read this' });
    const at = Date.now();
    await b.client.post(`/api/conversations/${encodeURIComponent(convo.id)}/read`, { at, private: true });

    const seenByA = await a.client.get('/api/bootstrap');
    assert.equal(seenByA.body.reads[convo.id][b.user.id], undefined, 'receipt must not leak');

    const seenByB = await b.client.get('/api/bootstrap');
    assert.equal(seenByB.body.reads[convo.id][b.user.id], at, 'reader keeps their own unread state');
  });
});

describe('contacts and directory', () => {
  test('contacts can be added and removed', async () => {
    const { a, b } = await pair('contacts');
    assert.equal((await a.client.post('/api/contacts', { contactId: b.user.id })).status, 200);
    assert.deepEqual((await a.client.get('/api/bootstrap')).body.contacts, [b.user.id]);

    await a.client.del(`/api/contacts/${b.user.id}`);
    assert.deepEqual((await a.client.get('/api/bootstrap')).body.contacts, []);
  });

  test('you cannot add yourself or a stranger that does not exist', async () => {
    const { client: c, user } = await signUp(srv.base, 'Lonely', 'lonely@test.io');
    assert.equal((await c.post('/api/contacts', { contactId: user.id })).status, 400);
    assert.equal((await c.post('/api/contacts', { contactId: 'u-nobody' })).status, 404);
  });

  test('directory search matches name, email and role', async () => {
    const { client: c } = await signUp(srv.base, 'Seeker', 'seeker@test.io');
    await signUp(srv.base, 'Zenobia Quill', 'zenobia@findme.test');

    const byName = await c.get('/api/users?q=zenobia');
    assert.ok(byName.body.users.some((u) => u.name === 'Zenobia Quill'));

    const byEmail = await c.get('/api/users?q=findme.test');
    assert.ok(byEmail.body.users.some((u) => u.name === 'Zenobia Quill'));

    const byRole = await c.get('/api/users?q=helpdesk');
    assert.ok(byRole.body.users.some((u) => u.role === 'IT Helpdesk'));
  });

  test('search never returns the caller', async () => {
    const { client: c, user } = await signUp(srv.base, 'Selfsearch', 'selfsearch@test.io');
    const res = await c.get('/api/users?q=selfsearch');
    assert.ok(!res.body.users.some((u) => u.id === user.id));
  });
});

describe('profile and settings', () => {
  test('settings round-trip through the account', async () => {
    const { client: c } = await signUp(srv.base, 'Settings User', 'settings@test.io');
    await c.put('/api/settings', { settings: { theme: 'deuteranopia', fontScale: 125 } });
    const boot = await c.get('/api/bootstrap');
    assert.equal(boot.body.settings.theme, 'deuteranopia');
    assert.equal(boot.body.settings.fontScale, 125);
  });

  test('profile updates validate the colour and reject an empty name', async () => {
    const { client: c } = await signUp(srv.base, 'Profile User', 'profile@test.io');
    assert.equal((await c.patch('/api/profile', { avatarColor: 'orange' })).status, 400);
    assert.equal((await c.patch('/api/profile', { name: '   ' })).status, 400);
    const ok = await c.patch('/api/profile', { name: 'Renamed', avatarColor: '#0E7490' });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.user.name, 'Renamed');
  });

  test('deleting the account removes its data', async () => {
    const { client: c, user } = await signUp(srv.base, 'Temporary', 'temp@test.io');
    assert.equal((await c.del('/api/account')).status, 200);
    assert.equal((await c.get('/api/me')).status, 401);

    const other = await signUp(srv.base, 'Observer', 'observer@test.io');
    const found = await other.client.get('/api/users?q=Temporary');
    assert.ok(!found.body.users.some((u) => u.id === user.id));
  });
});

describe('static hosting', () => {
  test('serves the app shell and refuses directory traversal', async () => {
    const page = await fetch(`${srv.base}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<title>Relay/);

    const escape = await fetch(`${srv.base}/../package.json`);
    assert.notEqual(escape.status, 200);
  });

  test('an unknown API endpoint is a clean 404', async () => {
    const res = await fetch(`${srv.base}/api/nope`);
    assert.equal(res.status, 404);
  });
});

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { startTestServer, signUp } from './helpers.js';

let srv;
before(async () => { srv = await startTestServer(); });
after(async () => { await srv.stop(); });

describe('editing your own profile', () => {
  test('every field round-trips', async () => {
    const { client: c } = await signUp(srv.base, 'Profile Owner', 'owner@profile.test');
    const res = await c.patch('/api/profile', {
      name: 'Renamed Owner',
      pronouns: 'they/them',
      title: 'Design Lead',
      bio: 'I build accessible interfaces.',
      statusEmoji: '🎧',
      statusText: 'Heads-down until 3pm',
      timezone: 'Europe/London',
      avatarColor: '#0E7490',
    });
    assert.equal(res.status, 200);
    const u = res.body.user;
    assert.equal(u.name, 'Renamed Owner');
    assert.equal(u.pronouns, 'they/them');
    assert.equal(u.title, 'Design Lead');
    assert.equal(u.bio, 'I build accessible interfaces.');
    assert.equal(u.statusEmoji, '🎧');
    assert.equal(u.statusText, 'Heads-down until 3pm');
    assert.equal(u.timezone, 'Europe/London');
    assert.equal(u.avatarColor, '#0E7490');
  });

  test('it survives a reload', async () => {
    const { client: c } = await signUp(srv.base, 'Persist Me', 'persist@profile.test');
    await c.patch('/api/profile', { title: 'Archivist', bio: 'Keeps the records.' });
    const boot = await c.get('/api/bootstrap');
    assert.equal(boot.body.me.title, 'Archivist');
    assert.equal(boot.body.me.bio, 'Keeps the records.');
  });

  test('a partial update leaves other fields alone', async () => {
    const { client: c } = await signUp(srv.base, 'Partial', 'partial@profile.test');
    await c.patch('/api/profile', { title: 'Keeper', pronouns: 'she/her' });
    const res = await c.patch('/api/profile', { bio: 'Only the bio changed.' });
    assert.equal(res.body.user.title, 'Keeper');
    assert.equal(res.body.user.pronouns, 'she/her');
    assert.equal(res.body.user.bio, 'Only the bio changed.');
  });

  test('blank input clears a field rather than storing whitespace', async () => {
    const { client: c } = await signUp(srv.base, 'Clearer', 'clearer@profile.test');
    await c.patch('/api/profile', { title: 'Temporary' });
    const res = await c.patch('/api/profile', { title: '   ' });
    assert.equal(res.body.user.title, null);
  });

  test('long values are trimmed to their limit, not rejected', async () => {
    const { client: c } = await signUp(srv.base, 'Verbose', 'verbose@profile.test');
    const res = await c.patch('/api/profile', { bio: 'x'.repeat(500) });
    assert.equal(res.body.user.bio.length, 280);
  });

  test('an empty name is still refused', async () => {
    const { client: c } = await signUp(srv.base, 'Nameless', 'nameless@profile.test');
    assert.equal((await c.patch('/api/profile', { name: '   ' })).status, 400);
  });

  test('an unknown time zone is refused', async () => {
    const { client: c } = await signUp(srv.base, 'Timezoned', 'tz@profile.test');
    assert.equal((await c.patch('/api/profile', { timezone: 'Mars/Olympus_Mons' })).status, 400);
    assert.equal((await c.patch('/api/profile', { timezone: 'Asia/Tokyo' })).status, 200);
  });

  test('a bad avatar colour is refused', async () => {
    const { client: c } = await signUp(srv.base, 'Colourful', 'colour@profile.test');
    assert.equal((await c.patch('/api/profile', { avatarColor: 'red' })).status, 400);
  });

  test('editing requires a session', async () => {
    const res = await fetch(`${srv.base}/api/profile`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'X-Relay-Client': '1' },
      body: JSON.stringify({ name: 'Imposter' }),
    });
    assert.equal(res.status, 401);
  });
});

describe('status expiry', () => {
  test('a status in the past is refused', async () => {
    const { client: c } = await signUp(srv.base, 'Past Status', 'past@profile.test');
    const res = await c.patch('/api/profile', { statusText: 'stale', statusUntil: Date.now() - 60000 });
    assert.equal(res.status, 400);
  });

  test('an expired status stops being reported', async () => {
    const { client: c } = await signUp(srv.base, 'Expiring', 'expiring@profile.test');
    // Set one far in the future, then rewrite the row to an expiry in the past.
    await c.patch('/api/profile', { statusText: 'In a meeting', statusUntil: Date.now() + 3600_000 });
    const { handle } = await import('../server/db.js');
    handle().prepare("UPDATE users SET status_until = ? WHERE email = ?")
      .run(Date.now() - 1000, 'expiring@profile.test');

    const boot = await c.get('/api/bootstrap');
    assert.equal(boot.body.me.statusText, null, 'an expired status must not be shown');
  });

  test('clearing the text clears the expiry with it', async () => {
    const { client: c } = await signUp(srv.base, 'Clean Status', 'cleanstatus@profile.test');
    await c.patch('/api/profile', { statusText: 'Busy', statusUntil: Date.now() + 3600_000 });
    const res = await c.patch('/api/profile', { statusText: '' });
    assert.equal(res.body.user.statusText, null);
    assert.equal(res.body.user.statusUntil, null);
  });
});

describe('viewing someone else', () => {
  test('a profile shows their public details', async () => {
    const viewer = await signUp(srv.base, 'Viewer One', 'viewer1@profile.test');
    const subject = await signUp(srv.base, 'Subject One', 'subject1@profile.test');
    await subject.client.patch('/api/profile', {
      title: 'Researcher', pronouns: 'he/him', bio: 'Studies things.', timezone: 'Asia/Tokyo',
    });

    const res = await viewer.client.get(`/api/users/${subject.user.id}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.user.name, 'Subject One');
    assert.equal(res.body.user.title, 'Researcher');
    assert.equal(res.body.user.bio, 'Studies things.');
    assert.equal(res.body.user.timezone, 'Asia/Tokyo');
    assert.equal(res.body.isSelf, false);
  });

  test("a stranger's email stays hidden, a contact's does not", async () => {
    const viewer = await signUp(srv.base, 'Viewer Two', 'viewer2@profile.test');
    const subject = await signUp(srv.base, 'Subject Two', 'subject2@profile.test');

    const before = await viewer.client.get(`/api/users/${subject.user.id}`);
    assert.equal(before.body.user.email, null, 'a stranger address must not be disclosed');

    await viewer.client.post('/api/contacts', { contactId: subject.user.id });
    const after = await viewer.client.get(`/api/users/${subject.user.id}`);
    assert.equal(after.body.user.email, 'subject2@profile.test');
    assert.equal(after.body.isContact, true);
  });

  test('shared groups and the direct conversation are reported', async () => {
    const a = await signUp(srv.base, 'Shared A', 'shareda@profile.test');
    const b = await signUp(srv.base, 'Shared B', 'sharedb@profile.test');
    const dm = await a.client.post('/api/conversations', { type: 'dm', members: [b.user.id] });
    await a.client.post('/api/conversations', { type: 'group', title: 'Launch Crew', members: [b.user.id] });

    const res = await a.client.get(`/api/users/${b.user.id}`);
    assert.equal(res.body.directConversationId, dm.body.conversation.id);
    assert.ok(res.body.sharedConversations.some((c) => c.title === 'Launch Crew'));
  });

  test('your own profile reports isSelf', async () => {
    const { client: c, user } = await signUp(srv.base, 'Myself', 'myself@profile.test');
    const res = await c.get(`/api/users/${user.id}`);
    assert.equal(res.body.isSelf, true);
    assert.equal(res.body.user.email, 'myself@profile.test', 'you can always see your own address');
  });

  test('a profile never leaks password material', async () => {
    const viewer = await signUp(srv.base, 'Viewer Three', 'viewer3@profile.test');
    const subject = await signUp(srv.base, 'Subject Three', 'subject3@profile.test');
    const res = await viewer.client.get(`/api/users/${subject.user.id}`);
    for (const field of ['pw_hash', 'pw_salt', 'pin_hash', 'pin_salt']) {
      assert.equal(res.body.user[field], undefined);
    }
  });

  test('an unknown id is a clean 404, and anonymous access is refused', async () => {
    const { client: c } = await signUp(srv.base, 'Prober', 'prober@profile.test');
    assert.equal((await c.get('/api/users/u-nobody-at-all')).status, 404);
    const anon = await fetch(`${srv.base}/api/users/u-nobody-at-all`);
    assert.equal(anon.status, 401);
  });
});

describe('profile changes reach other people', () => {
  test('a rename shows up for someone who shares a conversation', async () => {
    const a = await signUp(srv.base, 'Before Rename', 'rename-a@profile.test');
    const b = await signUp(srv.base, 'Watcher', 'rename-b@profile.test');
    await a.client.post('/api/conversations', { type: 'dm', members: [b.user.id] });

    await a.client.patch('/api/profile', { name: 'After Rename', statusEmoji: '🌴', statusText: 'On leave' });

    const seen = await b.client.get(`/api/users/${a.user.id}`);
    assert.equal(seen.body.user.name, 'After Rename');
    assert.equal(seen.body.user.statusText, 'On leave');
    assert.equal(seen.body.user.statusEmoji, '🌴');
  });

  test('search results carry the profile fields the UI renders', async () => {
    const viewer = await signUp(srv.base, 'Search Viewer', 'searchviewer@profile.test');
    const subject = await signUp(srv.base, 'Findable Person', 'findable@profile.test');
    await subject.client.patch('/api/profile', { title: 'Archivist', statusText: 'Away' });

    const res = await viewer.client.get('/api/users?q=findable');
    const found = res.body.users.find((u) => u.id === subject.user.id);
    assert.equal(found.title, 'Archivist');
    assert.equal(found.statusText, 'Away');
  });
});

// Two people who registered independently must be able to find each other.
//
// The client cache only holds accounts you already share a conversation with,
// so a UI that searches only the cache can never surface a stranger — which is
// exactly what "I can't find my other account" looked like. These tests pin the
// server contract that makes it possible, and the privacy limits on it.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { startTestServer, signUp } from './helpers.js';

let srv;
before(async () => { srv = await startTestServer(); });
after(async () => { await srv.stop(); });

describe('finding strangers', () => {
  test('a brand-new account is findable by name with no prior contact', async () => {
    const alice = await signUp(srv.base, 'Alice Zephyr', 'alice@dir.test');
    const bob = await signUp(srv.base, 'Bob Quasar', 'bob@dir.test');

    // Neither appears in the other's snapshot — no shared conversation.
    const boot = await alice.client.get('/api/bootstrap');
    assert.ok(!boot.body.users.some((u) => u.id === bob.user.id),
      'precondition: the stranger is absent from the cached snapshot');

    // The directory endpoint still finds them.
    const found = await alice.client.get('/api/users?q=quasar');
    assert.ok(found.body.users.some((u) => u.id === bob.user.id),
      'a separately registered account must be findable');
  });

  test('findable by email address, even without prior contact', async () => {
    const alice = await signUp(srv.base, 'Alice Two', 'alice2@dir.test');
    await signUp(srv.base, 'Carol Vega', 'carol.vega@findable.test');
    const found = await alice.client.get('/api/users?q=carol.vega@findable.test');
    assert.ok(found.body.users.some((u) => u.name === 'Carol Vega'));
  });

  test('an empty query lists people to browse', async () => {
    const { client: c } = await signUp(srv.base, 'Browser Person', 'browse@dir.test');
    const all = await c.get('/api/users?q=');
    assert.ok(all.body.users.length > 0, 'the directory should be browsable');
    assert.ok(all.body.users.every((u) => u.retired === false));
  });

  test('you can message someone found this way', async () => {
    const alice = await signUp(srv.base, 'Alice Three', 'alice3@dir.test');
    const dave = await signUp(srv.base, 'Dave Nebula', 'dave@dir.test');

    const found = await alice.client.get('/api/users?q=nebula');
    const target = found.body.users.find((u) => u.id === dave.user.id);
    assert.ok(target, 'found via search');

    const convo = await alice.client.post('/api/conversations', { type: 'dm', members: [target.id] });
    assert.equal(convo.status, 201);
    const sent = await alice.client.post(
      `/api/conversations/${encodeURIComponent(convo.body.conversation.id)}/messages`,
      { text: 'found you through search' },
    );
    assert.equal(sent.status, 201);

    // And it arrives.
    const boot = await dave.client.get('/api/bootstrap');
    const msgs = boot.body.messages[convo.body.conversation.id] || [];
    assert.deepEqual(msgs.map((m) => m.text), ['found you through search']);
  });

  test('search never returns the caller or retired accounts', async () => {
    const { client: c, user } = await signUp(srv.base, 'Selfless', 'selfless@dir.test');
    const res = await c.get('/api/users?q=selfless');
    assert.ok(!res.body.users.some((u) => u.id === user.id));
  });
});

describe('email privacy in the directory', () => {
  test("a stranger's email is withheld, though it still matches", async () => {
    const alice = await signUp(srv.base, 'Alice Four', 'alice4@dir.test');
    await signUp(srv.base, 'Erin Private', 'erin.private@secret.test');

    const byEmail = await alice.client.get('/api/users?q=erin.private@secret.test');
    const erin = byEmail.body.users.find((u) => u.name === 'Erin Private');
    assert.ok(erin, 'matching on the address must still work');
    assert.equal(erin.email, null, 'but the address itself must not be handed out');
  });

  test("a contact's email is visible", async () => {
    const alice = await signUp(srv.base, 'Alice Five', 'alice5@dir.test');
    const frank = await signUp(srv.base, 'Frank Known', 'frank@dir.test');
    await alice.client.post('/api/contacts', { contactId: frank.user.id });

    const res = await alice.client.get('/api/users?q=frank');
    assert.equal(res.body.users.find((u) => u.id === frank.user.id).email, 'frank@dir.test');
  });

  test("a conversation partner's email is visible", async () => {
    const alice = await signUp(srv.base, 'Alice Six', 'alice6@dir.test');
    const gina = await signUp(srv.base, 'Gina Partner', 'gina@dir.test');
    await alice.client.post('/api/conversations', { type: 'dm', members: [gina.user.id] });

    const res = await alice.client.get('/api/users?q=gina');
    assert.equal(res.body.users.find((u) => u.id === gina.user.id).email, 'gina@dir.test');
  });

  test('the directory cannot be used to harvest addresses in bulk', async () => {
    const { client: c } = await signUp(srv.base, 'Harvester', 'harvester@dir.test');
    const all = await c.get('/api/users?q=');
    const humanStrangers = all.body.users.filter((u) => !u.isBot && !u.isGuest);
    assert.ok(humanStrangers.length > 0, 'there are strangers in the results');
    assert.ok(humanStrangers.every((u) => u.email === null),
      'no stranger address may be disclosed');
  });

  test('search still never exposes password material', async () => {
    const { client: c } = await signUp(srv.base, 'Leak Check', 'leakcheck@dir.test');
    const res = await c.get('/api/users?q=');
    for (const u of res.body.users) {
      for (const field of ['pw_hash', 'pw_salt', 'pin_hash', 'pin_salt']) {
        assert.equal(u[field], undefined, `${field} must never be serialised`);
      }
    }
  });

  test('the directory requires a session', async () => {
    const res = await fetch(`${srv.base}/api/users?q=alice`);
    assert.equal(res.status, 401);
  });
});

describe('the client actually calls the directory endpoint', () => {
  const ui = readFileSync(new URL('../public/js/ui.js', import.meta.url), 'utf8');

  test('the people directory queries the server, not just the cache', () => {
    assert.match(ui, /async function fetchPeople\(q\)/);
    assert.match(ui, /db\.searchDirectory\(q\)/,
      'searching only the local cache is what hid separately registered accounts');
  });

  test('the new-conversation directory awaits server results', () => {
    assert.match(ui, /async function renderDirectory\(q\)/);
    assert.match(ui, /await fetchPeople\(q\)/);
  });

  test('global search merges server results in too', () => {
    assert.match(ui, /mergePeople\(remote, q\)/);
  });

  test('stale responses from earlier keystrokes are discarded', () => {
    assert.match(ui, /token !== peopleQuerySeq/);
  });
});

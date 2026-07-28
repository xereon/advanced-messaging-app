// Usernames.
//
// A handle is only worth having if it is unique, stable and something you can
// search by. Two accounts differing only in case would defeat all three, so
// most of what follows is about collisions and canonical form.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { readFileSync } from 'node:fs';

import { startTestServer, signUp } from './helpers.js';
import * as db from '../server/db.js';
import { slugifyUsername, usernameProblem, normalizeUsername } from '../server/username.js';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

let srv;
before(async () => { srv = await startTestServer(); });
after(async () => { await srv.stop(); });

describe('the rules', () => {
  test('canonical form ignores case, surrounding space and a leading @', () => {
    assert.equal(normalizeUsername('  @Ben_99 '), 'ben_99');
    assert.equal(normalizeUsername('@@ADA'), 'ada');
    assert.equal(normalizeUsername(null), '');
  });

  test('rejects what would make a handle useless or misleading', () => {
    assert.equal(usernameProblem('ada_l'), null);
    assert.match(usernameProblem('ab'), /at least 3/);
    assert.match(usernameProblem('a'.repeat(21)), /at most 20/);
    assert.match(usernameProblem('ada lovelace'), /letters, numbers and underscores/);
    assert.match(usernameProblem('ada-l'), /letters, numbers and underscores/);
    assert.match(usernameProblem('ada.l'), /letters, numbers and underscores/);
    // All-digit handles read as ids and collide with how people scan a list.
    assert.match(usernameProblem('12345'), /at least one letter/);
    assert.match(usernameProblem('___'), /at least one letter/);
    // Impersonating the service is the reason a reserved list exists at all.
    assert.match(usernameProblem('admin'), /reserved/);
    assert.match(usernameProblem('SUPPORT'), /reserved/);
    assert.match(usernameProblem('everyone'), /reserved/);
  });

  test('a display name becomes a sensible starting handle', () => {
    assert.equal(slugifyUsername('Ada Lovelace'), 'ada_lovelace');
    assert.equal(slugifyUsername('Zoë Ferreira'), 'zoe_ferreira');
    assert.equal(slugifyUsername("O'Brien-Smith"), 'o_brien_smith');
    // Nothing usable survives, so the caller has to supply a fallback.
    assert.equal(slugifyUsername('🎉🎉'), '');
    assert.equal(slugifyUsername('12345'), '');
  });
});

describe('allocation', () => {
  test('every new account gets one, derived from the name', async () => {
    const { user } = await signUp(srv.base, 'Ada Lovelace', 'ada@name.test');
    assert.equal(user.username, 'ada_lovelace');
  });

  test('a second person with the same name gets a distinct handle', async () => {
    const first = await signUp(srv.base, 'Sam Twin', 'sam1@name.test');
    const second = await signUp(srv.base, 'Sam Twin', 'sam2@name.test');
    assert.equal(first.user.username, 'sam_twin');
    assert.equal(second.user.username, 'sam_twin_2');
    assert.notEqual(first.user.username, second.user.username);
  });

  test('a name that slugifies to nothing still gets a handle', async () => {
    const { user } = await signUp(srv.base, '🎉🎉🎉', 'emoji@name.test');
    assert.ok(user.username, 'a handle is not optional');
    assert.equal(usernameProblem(user.username), null, 'and it obeys the rules');
  });

  test('guests get one too', async () => {
    const res = await fetch(`${srv.base}/api/auth/guest`, {
      method: 'POST', headers: { 'X-Relay-Client': '1' },
    });
    const { user } = await res.json();
    assert.ok(user.username, 'a guest is findable by handle like anyone else');
  });

  test('accounts that predate the column are backfilled', () => {
    // Stand in for an old row by clearing the handle the way the migration
    // would have found it.
    const row = db.handle().prepare('SELECT id FROM users WHERE email = ?').get('ada@name.test');
    db.handle().prepare('UPDATE users SET username = NULL WHERE id = ?').run(row.id);

    db.migrate();

    const after = db.handle().prepare('SELECT username FROM users WHERE id = ?').get(row.id);
    assert.ok(after.username, 'the backfill leaves nobody without a handle');
    assert.equal(usernameProblem(after.username), null);
  });
});

describe('choosing your own', () => {
  test('you can change it, and are then findable by the new one', async () => {
    const me = await signUp(srv.base, 'Rename Me', 'rename@name.test');
    const other = await signUp(srv.base, 'Watcher One', 'watcher@name.test');

    const res = await me.client.patch('/api/profile', { username: 'sparrow' });
    assert.equal(res.status, 200);
    assert.equal(res.body.user.username, 'sparrow');

    const found = await other.client.get('/api/users?q=@sparrow');
    assert.ok(found.body.users.some((u) => u.id === me.user.id));

    // The old handle stops resolving, since it is free again.
    const old = await other.client.get('/api/users?q=rename_me');
    assert.ok(!old.body.users.some((u) => u.id === me.user.id));
  });

  test('stored canonically, whatever the casing typed', async () => {
    const me = await signUp(srv.base, 'Case Test', 'case@name.test');
    const res = await me.client.patch('/api/profile', { username: '@MixedCase_1' });
    assert.equal(res.body.user.username, 'mixedcase_1');
  });

  test('a handle someone else holds is refused, in any casing', async () => {
    const holder = await signUp(srv.base, 'Holder Person', 'holder@name.test');
    await holder.client.patch('/api/profile', { username: 'taken_one' });
    const other = await signUp(srv.base, 'Other Person', 'other@name.test');

    const exact = await other.client.patch('/api/profile', { username: 'taken_one' });
    assert.equal(exact.status, 409);
    assert.match(exact.body.error, /already taken/);

    // Case is not a way around it — that would be the obvious impersonation.
    const cased = await other.client.patch('/api/profile', { username: 'Taken_One' });
    assert.equal(cased.status, 409);
  });

  test('keeping your own handle is not a collision with yourself', async () => {
    const me = await signUp(srv.base, 'Idem Potent', 'idem@name.test');
    const first = await me.client.patch('/api/profile', { username: 'idem_p' });
    assert.equal(first.status, 200);
    const again = await me.client.patch('/api/profile', { username: 'idem_p' });
    assert.equal(again.status, 200, 'saving the form twice must not fail');
    const cased = await me.client.patch('/api/profile', { username: '@IDEM_P' });
    assert.equal(cased.status, 200);
  });

  test('the rules are enforced server-side, not only in the form', async () => {
    const me = await signUp(srv.base, 'Rule Breaker', 'rules@name.test');
    for (const bad of ['ab', 'has space', 'has-dash', '12345', 'admin', 'a'.repeat(21)]) {
      const res = await me.client.patch('/api/profile', { username: bad });
      assert.equal(res.status, 400, `"${bad}" must be refused`);
    }
    // And none of them stuck.
    const boot = await me.client.get('/api/bootstrap');
    assert.equal(boot.body.me.username, 'rule_breaker');
  });

  test('an update that omits the username leaves it alone', async () => {
    const me = await signUp(srv.base, 'Leave Alone', 'leave@name.test');
    const res = await me.client.patch('/api/profile', { bio: 'Just a bio.' });
    assert.equal(res.status, 200);
    assert.equal(res.body.user.username, 'leave_alone');
  });
});

describe('where the handle shows up', () => {
  test('on your own account, on profiles and in search results', async () => {
    const subject = await signUp(srv.base, 'Shown Person', 'shown@name.test');
    const viewer = await signUp(srv.base, 'Viewer Person', 'viewer2@name.test');

    const boot = await subject.client.get('/api/bootstrap');
    assert.equal(boot.body.me.username, 'shown_person');

    const profile = await viewer.client.get(`/api/users/${subject.user.id}`);
    assert.equal(profile.body.user.username, 'shown_person');

    const found = await viewer.client.get('/api/users?q=shown');
    assert.equal(found.body.users.find((u) => u.id === subject.user.id).username, 'shown_person');
  });

  test('the elements the script reaches for are in the page', () => {
    const html = read('../public/index.html');
    const ui = read('../public/js/ui.js');
    // A missing id fails at runtime inside a dialog nobody opened during a test
    // run, so pin the pairing rather than trusting it.
    for (const id of ['set-username', 'username-error', 'profile-username']) {
      assert.match(html, new RegExp(`id="${id}"`), `#${id} must exist in the page`);
      assert.ok(ui.includes(`#${id}`), `#${id} must be used by the script`);
    }
  });

  test('the client will not query the server for a short term either', () => {
    const ui = read('../public/js/ui.js');
    assert.match(ui, /const DIRECTORY_MIN_QUERY = 3/,
      'the client keeps its own floor so nothing is sent before the threshold');
    assert.match(ui, /searchTerm\(q\)\.length < DIRECTORY_MIN_QUERY/,
      'and checks it before reaching for the network');
  });

  test('an exact handle match sorts above everyone who merely starts the same', async () => {
    const viewer = await signUp(srv.base, 'Sorter Person', 'sorter@name.test');
    const exact = await signUp(srv.base, 'Wren', 'wren@name.test');
    await signUp(srv.base, 'Wrenfield Hall', 'wrenfield@name.test');
    await signUp(srv.base, 'Wrendale Cooper', 'wrendale@name.test');

    const res = await viewer.client.get('/api/users?q=wren');
    assert.ok(res.body.users.length >= 3, 'precondition: several near matches');
    assert.equal(res.body.users[0].id, exact.user.id, 'the exact handle comes first');
  });
});

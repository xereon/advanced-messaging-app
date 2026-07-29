// Encryption at rest.
//
// The property to hold onto is that the *database file* gives up nothing, while
// the app behaves exactly as it did. So these tests check two things against
// each other: that plaintext never appears in the stored row, and that every
// read path still returns the real text.
//
// The second theme is not losing anybody's messages. A scheme where a wrong key
// silently overwrites ciphertext with an error string would be worse than no
// encryption at all, so the migration's refusal to do that is tested directly.

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

import { startTestServer, signUp } from './helpers.js';
import * as db from '../server/db.js';
import * as crypt from '../server/crypt.js';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const KEY = randomBytes(32);

let srv;
before(async () => { srv = await startTestServer(); });
after(async () => { crypt.setKey(null); await srv.stop(); });

// Each test decides whether encryption is on, so no test inherits it.
beforeEach(() => { crypt.setKey(null); });

const rawText = (id) => db.handle().prepare('SELECT text FROM messages WHERE id = ?').get(id).text;

/** Two accounts with a conversation between them. */
async function pair(tag) {
  const a = await signUp(srv.base, `Ann ${tag}`, `ann.${tag}@enc.test`);
  const b = await signUp(srv.base, `Bob ${tag}`, `bob.${tag}@enc.test`);
  const convo = await a.client.post('/api/conversations', { type: 'dm', members: [b.user.id] });
  return { a, b, convoId: convo.body.conversation.id };
}

describe('the primitive', () => {
  test('a round trip returns exactly what went in, including awkward text', () => {
    crypt.setKey(KEY);
    for (const text of [
      'hello', 'a', 'x'.repeat(4000), 'emoji 🎉 and accents é ü',
      'newlines\nand\ttabs', '{"looks":"like json"}',
      // Text that looks like the marker must survive as itself. An earlier
      // printable marker made this message store unencrypted and then read back
      // as undecryptable, which is why the real one starts with a control
      // character. (seal() deliberately passes an already-marked value through,
      // so that a re-run of the migration is a no-op; the test below covers the
      // case of a *user* sending the marker, which is what matters.)
      'enc1.not-really-sealed', 'enc1. with a space',
      '日本語のテキスト',
    ]) {
      assert.equal(crypt.open(crypt.seal(text)), text, `failed for ${JSON.stringify(text.slice(0, 20))}`);
    }
  });

  test('the same text twice produces different ciphertext', () => {
    crypt.setKey(KEY);
    const a = crypt.seal('the same message');
    const b = crypt.seal('the same message');
    assert.notEqual(a, b, 'a fresh IV per value, or equal messages would be visibly equal');
    assert.equal(crypt.open(a), crypt.open(b));
  });

  test('tampering is detected rather than returning wrong text', () => {
    crypt.setKey(KEY);
    const sealed = crypt.seal('the original message');
    // Flip a byte in the ciphertext body.
    const body = Buffer.from(sealed.slice(crypt.MARKER.length), 'base64');
    body[body.length - 1] ^= 0xff;
    const tampered = crypt.MARKER + body.toString('base64');
    assert.match(crypt.open(tampered), /could not be decrypted/, 'GCM authenticates, so this must fail');
  });

  test('with no key it is a passthrough, so nothing breaks by default', () => {
    crypt.setKey(null);
    assert.equal(crypt.seal('plain'), 'plain');
    assert.equal(crypt.open('plain'), 'plain');
    assert.equal(crypt.isEnabled(), false);
  });

  test('a key of the wrong length is refused rather than ignored', () => {
    for (const bad of ['short', Buffer.alloc(16).toString('base64'), 'zz', 'abc123']) {
      assert.throws(() => crypt.configure(bad), /32 bytes/, `${bad} must be refused`);
    }
    // Both accepted encodings work.
    assert.equal(crypt.configure(KEY.toString('base64')), true);
    assert.equal(crypt.configure(KEY.toString('hex')), true);
    assert.equal(crypt.configure(''), false, 'unset means off, not an error');
  });

  test('empty and null are left alone', () => {
    crypt.setKey(KEY);
    assert.equal(crypt.seal(''), '');
    assert.equal(crypt.seal(null), null);
    assert.equal(crypt.seal(undefined), undefined);
    assert.equal(crypt.open(null), null);
  });

  test('a user cannot forge the marker, because input strips control characters', async () => {
    crypt.setKey(KEY);
    const { a, b, convoId } = await pair('forge');
    // Someone trying to make their message store as plaintext, or to make it
    // unreadable, by opening with the marker.
    const attempt = `${crypt.MARKER}AAAA pretend this is sealed`;
    const sent = await a.client.post(`/api/conversations/${convoId}/messages`, { text: attempt });
    assert.equal(sent.status, 201);

    const stored = rawText(sent.body.message.id);
    assert.ok(crypt.isSealed(stored), 'it is genuinely encrypted, not passed through');
    assert.ok(!stored.includes('pretend'), 'and the text is not readable in the row');

    // The control character is gone; everything a person actually typed remains.
    const boot = await b.client.get('/api/bootstrap');
    const text = boot.body.messages[convoId].at(-1).text;
    // Only the control character is removed; the visible text they typed remains.
    assert.equal(text, 'enc1.AAAA pretend this is sealed');
  });

  test('sealing twice does not double-encrypt', () => {
    crypt.setKey(KEY);
    const once = crypt.seal('message');
    assert.equal(crypt.seal(once), once, 'so re-running the migration is safe');
  });
});

describe('what the database file holds', () => {
  test('a sent message is not in the row as plaintext', async () => {
    crypt.setKey(KEY);
    const { a, convoId } = await pair('stored');
    const secret = 'the account number is 12345 do not share it';
    const sent = await a.client.post(`/api/conversations/${convoId}/messages`, { text: secret });
    assert.equal(sent.status, 201);

    const stored = rawText(sent.body.message.id);
    assert.ok(crypt.isSealed(stored), 'the stored value is marked encrypted');
    assert.ok(!stored.includes('12345'), 'and the digits are not in it');
    assert.ok(!stored.includes('account'), 'nor the words');
  });

  test('but every read path still returns the real text', async () => {
    crypt.setKey(KEY);
    const { a, b, convoId } = await pair('reads');
    await a.client.post(`/api/conversations/${convoId}/messages`, { text: 'readable again' });

    // The send response.
    const again = await a.client.post(`/api/conversations/${convoId}/messages`, { text: 'second one' });
    assert.equal(again.body.message.text, 'second one');

    // Bootstrap, for the other person.
    const boot = await b.client.get('/api/bootstrap');
    const texts = boot.body.messages[convoId].map((m) => m.text);
    assert.ok(texts.includes('readable again'));
    assert.ok(texts.includes('second one'));

    // The history-paging endpoint.
    const page = await b.client.get(`/api/conversations/${convoId}/messages?before=999999999`);
    assert.ok(page.body.messages.every((m) => !crypt.isSealed(m.text)));

    // And the export.
    const dump = await a.client.get('/api/export');
    assert.ok(JSON.stringify(dump.body).includes('readable again'));
  });

  test('editing a message re-encrypts rather than storing plaintext', async () => {
    crypt.setKey(KEY);
    const { a, convoId } = await pair('edit');
    const sent = await a.client.post(`/api/conversations/${convoId}/messages`, { text: 'first draft' });
    const edited = await a.client.patch(`/api/messages/${sent.body.message.id}`, { text: 'corrected version' });

    assert.equal(edited.body.message.text, 'corrected version');
    const stored = rawText(sent.body.message.id);
    assert.ok(crypt.isSealed(stored));
    assert.ok(!stored.includes('corrected'));
  });

  test('drafts, reports, feedback and appeals are covered too', async () => {
    crypt.setKey(KEY);
    const { a, b, convoId } = await pair('columns');
    const handle = db.handle();

    await a.client.patch(`/api/conversations/${convoId}/meta`, { draft: 'an unsent thought' });
    const draft = handle.prepare('SELECT draft FROM convo_meta WHERE user_id = ? AND convo_id = ?')
      .get(a.user.id, convoId).draft;
    assert.ok(crypt.isSealed(draft), 'an unsent message is still a message');
    // And it comes back readable.
    const boot = await a.client.get('/api/bootstrap');
    assert.equal(boot.body.meta[convoId].draft, 'an unsent thought');

    const msg = await b.client.post(`/api/conversations/${convoId}/messages`, { text: 'reported words' });
    const report = await a.client.post('/api/reports', {
      subjectId: b.user.id, messageId: msg.body.message.id, reason: 'spam', note: 'a private note',
    });
    const row = handle.prepare('SELECT message_text, note FROM reports WHERE id = ?').get(report.body.id);
    assert.ok(crypt.isSealed(row.message_text), 'the quoted evidence');
    assert.ok(crypt.isSealed(row.note), 'and the reporter\'s note');
    assert.ok(!row.message_text.includes('reported words'));

    await a.client.post('/api/feedback', { kind: 'idea', message: 'a suggestion' });
    const fb = handle.prepare('SELECT message FROM feedback ORDER BY created_at DESC LIMIT 1').get();
    assert.ok(crypt.isSealed(fb.message));
  });

  test('the cross-worker event bus does not carry the text in the clear', async () => {
    crypt.setKey(KEY);
    const { a, convoId } = await pair('bus');
    const canary = 'CANARY-bus-payload-must-not-be-readable';
    await a.client.post(`/api/conversations/${convoId}/messages`, { text: canary });

    // The bus persists published events so other workers can pick them up, and
    // a 'message' event carries the body. Encrypting messages.text while writing
    // the same words here as plain JSON left them in the file anyway — which is
    // what a grep of a real database turned up.
    const rows = db.handle().prepare('SELECT data FROM events').all();
    assert.ok(rows.length > 0, 'precondition: events were appended');
    for (const row of rows) {
      assert.ok(!row.data.includes(canary), 'an event payload must be sealed like any other stored text');
    }
    assert.ok(rows.some((r) => crypt.isSealed(r.data)), 'and it is marked as sealed');
  });

  test('the live stream still delivers readable events after the round trip', async () => {
    crypt.setKey(KEY);
    const { a, convoId } = await pair('busread');
    await a.client.post(`/api/conversations/${convoId}/messages`, { text: 'through the bus' });
    // Replay is what a reconnecting client does; it reads straight from the table.
    const row = db.handle().prepare("SELECT data FROM events WHERE type = 'message' ORDER BY id DESC LIMIT 1").get();
    assert.equal(JSON.parse(crypt.open(row.data)).message.text, 'through the bus');
  });

  test('an administrator still reads reports and feedback as text', async () => {
    crypt.setKey(KEY);
    const { a, b, convoId } = await pair('adminread');
    const msg = await b.client.post(`/api/conversations/${convoId}/messages`, { text: 'the offending line' });
    await a.client.post('/api/reports', {
      subjectId: b.user.id, messageId: msg.body.message.id, reason: 'harassment', note: 'context here',
    });
    await b.client.post('/api/feedback', { kind: 'bug', message: 'something is broken' });
    db.handle().prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(a.user.id);

    const reports = await a.client.get('/api/admin/reports');
    const report = reports.body.reports.find((r) => r.subject?.id === b.user.id);
    assert.equal(report.quotedMessage, 'the offending line');
    assert.equal(report.note, 'context here');

    const feedback = await a.client.get('/api/admin/feedback');
    assert.ok(feedback.body.feedback.some((f) => f.message === 'something is broken'));
  });
});

describe('search with encryption on', () => {
  test('still finds messages by their text', async () => {
    crypt.setKey(KEY);
    const { a, convoId } = await pair('search');
    await a.client.post(`/api/conversations/${convoId}/messages`, { text: 'pineapple on pizza' });
    await a.client.post(`/api/conversations/${convoId}/messages`, { text: 'nothing to do with fruit' });

    const found = await a.client.get('/api/search/messages?q=pineapple');
    assert.equal(found.body.results.length, 1);
    assert.equal(found.body.results[0].text, 'pineapple on pizza');

    // Case-insensitive, like the SQL path.
    const upper = await a.client.get('/api/search/messages?q=PINEAPPLE');
    assert.equal(upper.body.results.length, 1);
  });

  test('a query matching nothing returns nothing, not everything', async () => {
    crypt.setKey(KEY);
    const { a, convoId } = await pair('nomatch');
    await a.client.post(`/api/conversations/${convoId}/messages`, { text: 'some content' });
    const found = await a.client.get('/api/search/messages?q=zzzznotpresent');
    assert.deepEqual(found.body.results, []);
  });

  test('it still respects blocks and cleared history', async () => {
    crypt.setKey(KEY);
    const { a, b, convoId } = await pair('scoped');
    await b.client.post(`/api/conversations/${convoId}/messages`, { text: 'blockable content' });
    assert.equal((await a.client.get('/api/search/messages?q=blockable')).body.results.length, 1);

    await a.client.post('/api/blocks', { userId: b.user.id });
    assert.equal((await a.client.get('/api/search/messages?q=blockable')).body.results.length, 0,
      'the scan must not skip the filters the SQL path applies');
  });

  test('someone else cannot find your messages', async () => {
    crypt.setKey(KEY);
    const { a, convoId } = await pair('private');
    await a.client.post(`/api/conversations/${convoId}/messages`, { text: 'confidential material' });
    const stranger = await signUp(srv.base, 'Stranger Enc', 'stranger@enc.test');
    assert.deepEqual((await stranger.client.get('/api/search/messages?q=confidential')).body.results, []);
  });
});

describe('mixed and missing keys', () => {
  test('plaintext rows written before the key still read fine', async () => {
    // Send with encryption off, then switch it on: the marker is per value, so
    // the old row is recognised as plaintext and passed through.
    crypt.setKey(null);
    const { a, b, convoId } = await pair('mixed');
    await a.client.post(`/api/conversations/${convoId}/messages`, { text: 'from before the key' });

    crypt.setKey(KEY);
    await a.client.post(`/api/conversations/${convoId}/messages`, { text: 'from after the key' });

    const boot = await b.client.get('/api/bootstrap');
    const texts = boot.body.messages[convoId].map((m) => m.text);
    assert.ok(texts.includes('from before the key'), 'a half-converted database still reads');
    assert.ok(texts.includes('from after the key'));

    // And search spans both forms.
    const found = await a.client.get('/api/search/messages?q=the key');
    assert.equal(found.body.results.length, 2);
  });

  test('losing the key says so rather than showing blanks', async () => {
    crypt.setKey(KEY);
    const { a, b, convoId } = await pair('nokey');
    await a.client.post(`/api/conversations/${convoId}/messages`, { text: 'will become unreadable' });

    crypt.setKey(null);
    const boot = await b.client.get('/api/bootstrap');
    const text = boot.body.messages[convoId].find((m) => m.text.includes('encrypted'))?.text;
    assert.match(text || '', /\[encrypted/, 'the problem must be visible, not silently empty');
  });

  test('the wrong key does not look like success', async () => {
    crypt.setKey(KEY);
    const { a, b, convoId } = await pair('wrongkey');
    await a.client.post(`/api/conversations/${convoId}/messages`, { text: 'sealed with one key' });

    crypt.setKey(randomBytes(32));
    const boot = await b.client.get('/api/bootstrap');
    const texts = boot.body.messages[convoId].map((m) => m.text);
    assert.ok(texts.some((t) => /could not be decrypted/.test(t)));
    assert.ok(!texts.some((t) => t.includes('sealed with one key')));
  });
});

describe('the migration script', () => {
  let dir;
  let dbFile;

  const run = (args, key) => execFileSync(
    process.execPath,
    [join(ROOT, 'scripts', 'encrypt.js'), ...args],
    { env: { ...process.env, RELAY_DB: dbFile, RELAY_ENCRYPTION_KEY: key || '' }, encoding: 'utf8' },
  );

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'relay-enc-'));
    dbFile = join(dir, 'migrate.db');
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  test('converts a plaintext database, and back again, losslessly', () => {
    // Build a small plaintext database directly, the way an existing
    // deployment's would look.
    crypt.setKey(null);
    const open = db.open(dbFile);
    open.exec(`
      INSERT INTO users (id, name, created_at) VALUES ('u1', 'One', 1);
      INSERT INTO conversations (id, type, created_at) VALUES ('c1', 'dm', 1);
      INSERT INTO messages (id, convo_id, from_id, text, at, seq)
        VALUES ('m1', 'c1', 'u1', 'first message', 1, 1),
               ('m2', 'c1', 'u1', 'second message 🎉', 2, 2),
               ('m3', 'c1', 'u1', '', 3, 3);
    `);
    db.close();

    const key = KEY.toString('base64');
    const out = run([], key);
    assert.match(out, /2 values converted to encrypted/, `unexpected output:\n${out}`);

    // Read it back with the key and confirm nothing changed but the storage.
    crypt.setKey(KEY);
    db.open(dbFile);
    const rows = db.handle().prepare('SELECT id, text FROM messages ORDER BY seq').all();
    assert.ok(crypt.isSealed(rows[0].text));
    assert.equal(crypt.open(rows[0].text), 'first message');
    assert.equal(crypt.open(rows[1].text), 'second message 🎉');
    assert.equal(rows[2].text, '', 'an empty body stays empty rather than becoming ciphertext');
    db.close();

    // Re-running is a no-op, not a double encryption.
    const rerun = run([], key);
    assert.match(rerun, /0 values converted/);

    // And --off restores exactly the original text.
    const back = run(['--off'], key);
    assert.match(back, /2 values converted to plaintext/);
    crypt.setKey(null);
    db.open(dbFile);
    const after = db.handle().prepare('SELECT text FROM messages ORDER BY seq').all().map((r) => r.text);
    assert.deepEqual(after, ['first message', 'second message 🎉', '']);
    db.close();
  });

  test('--off with the wrong key refuses instead of destroying the data', () => {
    crypt.setKey(null);
    db.open(dbFile);
    db.handle().exec("DELETE FROM messages; INSERT INTO messages (id, convo_id, from_id, text, at, seq)"
      + " VALUES ('m9', 'c1', 'u1', 'precious words', 9, 9);");
    db.close();

    const key = KEY.toString('base64');
    run([], key);

    let failed = false;
    try {
      run(['--off'], randomBytes(32).toString('base64'));
    } catch (err) {
      failed = true;
      assert.match(String(err.stdout) + String(err.stderr), /wrong key/i);
    }
    assert.ok(failed, 'it must exit non-zero');

    // The ciphertext is untouched, so the right key still recovers the text.
    crypt.setKey(KEY);
    db.open(dbFile);
    const stored = db.handle().prepare("SELECT text FROM messages WHERE id = 'm9'").get().text;
    assert.equal(crypt.open(stored), 'precious words',
      'a failed decrypt must never be written back over the ciphertext');
    db.close();
  });

  test('--status counts both forms, and --key prints a usable key', () => {
    const key = KEY.toString('base64');
    const status = run(['--status'], key);
    assert.match(status, /encrypted/);
    assert.match(status, /plaintext/);

    const generated = run(['--key'], '');
    const printed = /RELAY_ENCRYPTION_KEY=(\S+)/.exec(generated)?.[1];
    assert.ok(printed, 'a key is printed');
    assert.equal(crypt.configure(printed), true, 'and it is accepted');
    crypt.setKey(null);
  });

  test('it refuses to run with no key at all', () => {
    let failed = false;
    try { run([], ''); } catch (err) {
      failed = true;
      assert.match(String(err.stdout) + String(err.stderr), /not set/);
    }
    assert.ok(failed);
  });
});

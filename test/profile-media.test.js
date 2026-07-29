// Profile photos, last-online, mentions and the emoji picker.
//
// The photo half is the part with real server surface, so most of this is about
// what the avatar endpoint will and will not accept — an image route that trusts
// a declared content type is an upload-anything route.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

import { startTestServer, signUp, client } from './helpers.js';
import * as db from '../server/db.js';
import { renderRich, mentionedHandles } from '../public/js/util.js';

let srv;
before(async () => { srv = await startTestServer(); });
after(async () => { await srv.stop(); });

/** A real, minimal PNG — the type is sniffed, so a fake header would not do. */
function png(w = 8, h = 8) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  let o = 0;
  for (let y = 0; y < h; y++) { raw[o++] = 0; for (let x = 0; x < w; x++) { raw[o++] = 200; raw[o++] = 60; raw[o++] = 120; } }
  const crc = (buf) => {
    let c = ~0;
    for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1)); }
    const out = Buffer.alloc(4); out.writeUInt32BE((~c) >>> 0); return out;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    return Buffer.concat([len, body, crc(body)]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

const upload = (cookie, body, type = 'image/png') => fetch(`${srv.base}/api/profile/avatar`, {
  method: 'POST',
  headers: { Cookie: cookie, 'X-Relay-Client': '1', 'Content-Type': type },
  body,
});

describe('profile photos', () => {
  test('uploading gives back a URL that serves the image', async () => {
    const me = await signUp(srv.base, 'Pic One', 'pic1@media.test');
    const res = await upload(me.client.cookie, png());
    assert.equal(res.status, 200);
    const { user } = await res.json();
    assert.match(user.avatarUrl, /^\/api\/users\/.+\/avatar\?v=\d+$/);

    const img = await fetch(srv.base + user.avatarUrl, { headers: { Cookie: me.client.cookie } });
    assert.equal(img.status, 200);
    assert.equal(img.headers.get('content-type'), 'image/png');
    assert.equal(img.headers.get('x-content-type-options'), 'nosniff');
    assert.match(img.headers.get('content-security-policy'), /default-src 'none'/);
    assert.ok((await img.arrayBuffer()).byteLength > 0);
  });

  test('the URL changes when the photo does, so a cache cannot serve the old one', async () => {
    const me = await signUp(srv.base, 'Pic Two', 'pic2@media.test');
    const first = (await (await upload(me.client.cookie, png())).json()).user.avatarUrl;
    await new Promise((r) => setTimeout(r, 5));
    const second = (await (await upload(me.client.cookie, png(10, 10))).json()).user.avatarUrl;
    assert.notEqual(first, second, 'the ?v= stamp has to move');
    assert.match(second, /\?v=\d+$/);
  });

  test('the type is sniffed, not taken from the request', async () => {
    const me = await signUp(srv.base, 'Pic Three', 'pic3@media.test');
    // Claims to be a PNG; is not one.
    const res = await upload(me.client.cookie, Buffer.from('<svg onload=alert(1)></svg>'), 'image/png');
    assert.equal(res.status, 415);
    assert.match((await res.json()).error, /PNG, JPEG or WebP/);
    assert.equal(db.handle().prepare('SELECT avatar_path FROM users WHERE id = ?')
      .get(me.user.id).avatar_path, null, 'and nothing is stored');
  });

  test('an empty body is refused', async () => {
    const me = await signUp(srv.base, 'Pic Four', 'pic4@media.test');
    assert.equal((await upload(me.client.cookie, Buffer.alloc(0))).status, 400);
  });

  test('photos are for signed-in people, not the open internet', async () => {
    const me = await signUp(srv.base, 'Pic Five', 'pic5@media.test');
    const { user } = await (await upload(me.client.cookie, png())).json();
    assert.equal((await fetch(srv.base + user.avatarUrl)).status, 401);
    // But any signed-in account can see it — it is a profile photo, not a secret.
    const other = await signUp(srv.base, 'Viewer Five', 'viewer5@media.test');
    assert.equal((await fetch(srv.base + user.avatarUrl, { headers: { Cookie: other.client.cookie } })).status, 200);
  });

  test('removing it clears the pointer and the URL', async () => {
    const me = await signUp(srv.base, 'Pic Six', 'pic6@media.test');
    await upload(me.client.cookie, png());
    const gone = await me.client.del('/api/profile/avatar');
    assert.equal(gone.status, 200);
    assert.equal(gone.body.user.avatarUrl, null);
    assert.equal((await me.client.get('/api/me')).body.user.avatarUrl, null);
  });

  test('an account without one reports null rather than a broken URL', async () => {
    const me = await signUp(srv.base, 'Pic Seven', 'pic7@media.test');
    assert.equal((await me.client.get('/api/me')).body.user.avatarUrl, null);
    assert.equal((await me.client.get(`/api/users/${me.user.id}/avatar`)).status, 404);
  });

  test('uploading requires a session', async () => {
    assert.equal((await fetch(`${srv.base}/api/profile/avatar`, {
      method: 'POST', headers: { 'X-Relay-Client': '1', 'Content-Type': 'image/png' }, body: png(),
    })).status, 401);
  });
});

describe('last online', () => {
  test('it is shared by default, and withheld when turned off', async () => {
    const subject = await signUp(srv.base, 'Seen Person', 'seen@media.test');
    const viewer = await signUp(srv.base, 'Seen Viewer', 'seenviewer@media.test');
    db.handle().prepare('UPDATE users SET last_seen = ? WHERE id = ?')
      .run(Date.now() - 30 * 60_000, subject.user.id);

    let seen = (await viewer.client.get(`/api/users/${subject.user.id}`)).body.user;
    assert.ok(seen.lastSeen > 0, 'shared by default');
    assert.equal(seen.sharesLastSeen, true);

    await subject.client.patch('/api/profile', { shareLastSeen: false });
    seen = (await viewer.client.get(`/api/users/${subject.user.id}`)).body.user;
    assert.equal(seen.lastSeen, null, 'withheld, not zeroed to look like "never"');
    assert.equal(seen.sharesLastSeen, false);

    await subject.client.patch('/api/profile', { shareLastSeen: true });
    assert.ok((await viewer.client.get(`/api/users/${subject.user.id}`)).body.user.lastSeen > 0);
  });

  test('hiding it does not hide whether they are online now', async () => {
    const subject = await signUp(srv.base, 'Online Person', 'onlineperson@media.test');
    await subject.client.patch('/api/profile', { shareLastSeen: false });
    const viewer = await signUp(srv.base, 'Online Viewer', 'onlineviewer@media.test');
    const res = await viewer.client.get(`/api/users/${subject.user.id}`);
    assert.equal(res.status, 200);
    assert.ok('online' in res.body, 'presence is a separate question and still answered');
  });
});

describe('mentions', () => {
  const mentions = new Map([['ada_photo', 'Ada'], ['grace_away', 'Grace']]);

  test('only handles that belong to somebody are marked up', () => {
    const html = renderRich('hi @ada_photo and @nobody_here', { mentions });
    assert.match(html, /class="mention">@ada_photo</);
    assert.ok(!/@nobody_here<\/span>/.test(html), 'an unknown handle stays plain text');
  });

  test('your own mention is marked differently from anyone else\'s', () => {
    const html = renderRich('@ada_photo @grace_away', { mentions, meHandle: 'ada_photo' });
    assert.match(html, /class="mention mention-me">@ada_photo/);
    assert.match(html, /class="mention">@grace_away/);
  });

  test('an email address is not a mention', () => {
    const html = renderRich('write to name@example.com', { mentions: new Map([['example', 'x']]) });
    assert.ok(!/class="mention"/.test(html), 'the @ has to start a word');
  });

  test('mentions are still escaped, like everything else', () => {
    const html = renderRich('<script>x</script> @ada_photo', { mentions });
    assert.ok(!html.includes('<script>'), 'markup in a message is never markup in the page');
  });

  test('nothing is marked up when no handles are supplied', () => {
    assert.ok(!/class="mention"/.test(renderRich('@ada_photo', {})));
  });

  test('mentionedHandles finds only the real ones', () => {
    assert.deepEqual([...mentionedHandles('@ada_photo hi @nope', mentions)], ['ada_photo']);
    assert.deepEqual([...mentionedHandles('no mentions', mentions)], []);
  });
});

describe('the emoji picker', () => {
  const src = readFileSync(new URL('../public/js/emoji.js', import.meta.url), 'utf8');

  test('there are many more than the old fixed row', async () => {
    const emoji = await import('../public/js/emoji.js');
    const total = emoji.CATEGORIES.reduce((n, c) => n + c.emoji.length, 0);
    assert.ok(total > 300, `expected a real set, got ${total}`);
    const all = emoji.allEmoji();
    assert.equal(all.length, new Set(all).size, 'and no duplicates');
  });

  test('every entry has search keywords, or it cannot be found', async () => {
    const emoji = await import('../public/js/emoji.js');
    for (const cat of emoji.CATEGORIES) {
      for (const [char, keywords] of cat.emoji) {
        assert.ok(keywords && keywords.trim(), `${char} in ${cat.id} has no keywords`);
      }
    }
  });

  test('search matches the start of a keyword, not anywhere inside one', async () => {
    const emoji = await import('../public/js/emoji.js');
    assert.deepEqual(emoji.searchEmoji('thanks'), ['🙏']);
    assert.ok(emoji.searchEmoji('fire').includes('🔥'));
    // "an" should find angry and animals, not banana.
    assert.ok(!emoji.searchEmoji('an').includes('🍌'));
    assert.deepEqual(emoji.searchEmoji(''), [], 'an empty query is not a match-all');
  });

  test('it is a module of its own, so the data does not live in ui.js', () => {
    assert.match(src, /export const CATEGORIES/);
    const ui = readFileSync(new URL('../public/js/ui.js', import.meta.url), 'utf8');
    assert.ok(!/const EMOJI_SET = \[/.test(ui), 'the old hardcoded row is gone');
    assert.ok(!/const REACT_SET = \[/.test(ui));
  });
});

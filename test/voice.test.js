// voice.test.js — voice notes.
//
// A voice note is an ordinary attachment with two extra facts and one extra
// rule: it must be a container we can actually play, and it is the only non-image
// type served inline rather than handed over as a download. Both of those are
// security-adjacent, so they are pinned here rather than left to the UI.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { startTestServer, signUp } from './helpers.js';
import * as files from '../server/files.js';

let srv;
let me;
let convo;

// Just enough of each container for the sniffer to recognise it. The bytes after
// the magic number are never parsed, so filler is honest here.
const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(64, 7)]);
const OGG = Buffer.concat([Buffer.from('OggS'), Buffer.alloc(64, 7)]);
const MP4 = Buffer.concat([Buffer.alloc(4), Buffer.from('ftypM4A '), Buffer.alloc(64, 7)]);
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7),
]);

/** Upload raw bytes the way the browser does — body plus headers, no multipart. */
async function upload(base, cookie, convoId, body, headers = {}) {
  const res = await fetch(`${base}/api/conversations/${convoId}/attachments`, {
    method: 'POST',
    headers: {
      'X-Relay-Client': '1',
      Cookie: cookie,
      'Content-Type': 'application/octet-stream',
      ...headers,
    },
    body,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : {} };
}

const asVoice = (extra = {}) => ({
  'X-Relay-Voice': '1',
  'X-Relay-Filename': 'voice-note',
  ...extra,
});

before(async () => {
  srv = await startTestServer();
  me = await signUp(srv.base, 'Voice Sender', 'voice@notes.test');
  const peer = await signUp(srv.base, 'Voice Peer', 'peer@notes.test');
  const made = await me.client.post('/api/conversations', { type: 'dm', members: [peer.user.id] });
  convo = made.body.conversation.id;
});

after(async () => { await srv.stop(); });

describe('recording formats', () => {
  test('webm is accepted', async () => {
    const res = await upload(srv.base, me.client.cookie, convo, WEBM, asVoice({ 'X-Relay-Duration': '3400' }));
    assert.equal(res.status, 201);
    assert.equal(res.body.attachment.mime, 'audio/webm');
    assert.equal(res.body.attachment.isVoice, true);
    assert.equal(res.body.attachment.durationMs, 3400);
  });

  test('ogg is accepted', async () => {
    const res = await upload(srv.base, me.client.cookie, convo, OGG, asVoice());
    assert.equal(res.status, 201);
    assert.equal(res.body.attachment.mime, 'audio/ogg');
  });

  test('mp4 is accepted, because Safari produces nothing else', async () => {
    const res = await upload(srv.base, me.client.cookie, convo, MP4, asVoice());
    assert.equal(res.status, 201);
    assert.equal(res.body.attachment.mime, 'audio/mp4');
  });

  test('something that is not a media container is refused', async () => {
    const res = await upload(srv.base, me.client.cookie, convo, Buffer.from('<html>not audio</html>'), asVoice());
    assert.equal(res.status, 415);
    assert.match(res.body.error, /format we can play/i);
  });

  test('an image routed through the voice header is refused', async () => {
    // The header is a claim; the bytes decide. A PNG is a real container, just
    // not one anybody can listen to.
    const res = await upload(srv.base, me.client.cookie, convo, PNG, asVoice());
    assert.equal(res.status, 415);
  });

  test('the claimed content type does not decide anything', async () => {
    // Claiming audio over HTML bytes must not produce a playable attachment.
    const res = await upload(srv.base, me.client.cookie, convo, Buffer.from('<script>alert(1)</script>'),
      asVoice({ 'Content-Type': 'audio/webm' }));
    assert.equal(res.status, 415);
  });
});

describe('duration', () => {
  test('is clamped to the recording cap rather than trusted', async () => {
    const res = await upload(srv.base, me.client.cookie, convo, WEBM,
      asVoice({ 'X-Relay-Duration': String(60 * 60 * 1000) }));
    assert.equal(res.status, 201);
    assert.equal(res.body.attachment.durationMs, files.MAX_VOICE_MS);
  });

  test('nonsense becomes nothing rather than NaN', async () => {
    const res = await upload(srv.base, me.client.cookie, convo, WEBM,
      asVoice({ 'X-Relay-Duration': 'twelve' }));
    assert.equal(res.status, 201);
    assert.equal(res.body.attachment.durationMs, null);
  });

  test('a negative figure cannot make a bubble narrower than nothing', async () => {
    const res = await upload(srv.base, me.client.cookie, convo, WEBM,
      asVoice({ 'X-Relay-Duration': '-9000' }));
    assert.equal(res.status, 201);
    assert.equal(res.body.attachment.durationMs, null);
  });
});

describe('the ordinary attachment path is unchanged', () => {
  test('a webm uploaded as a file is still a download, not audio', async () => {
    // Widening the general sniffer would have meant every .webm attachment
    // suddenly being served inline. It is only the voice path that plays things.
    const res = await upload(srv.base, me.client.cookie, convo, WEBM, { 'X-Relay-Filename': 'clip.webm' });
    assert.equal(res.status, 201);
    assert.equal(res.body.attachment.mime, 'application/octet-stream');
    assert.equal(res.body.attachment.isVoice, false);
    assert.equal(res.body.attachment.durationMs, null);
  });

  test('an image is still an image', async () => {
    const res = await upload(srv.base, me.client.cookie, convo, PNG, { 'X-Relay-Filename': 'shot.png' });
    assert.equal(res.status, 201);
    assert.equal(res.body.attachment.mime, 'image/png');
    assert.equal(res.body.attachment.isImage, true);
    assert.equal(res.body.attachment.isVoice, false);
  });
});

describe('serving', () => {
  test('a voice note is served inline so it can be played where it sits', async () => {
    const up = await upload(srv.base, me.client.cookie, convo, WEBM, asVoice({ 'X-Relay-Duration': '2000' }));
    const res = await fetch(`${srv.base}${up.body.attachment.url}`, {
      headers: { 'X-Relay-Client': '1', Cookie: me.client.cookie },
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'audio/webm');
    assert.match(res.headers.get('content-disposition'), /^inline/);
    // The hardening that makes serving it inline acceptable at all.
    assert.match(res.headers.get('content-security-policy'), /default-src 'none'; sandbox/);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  });

  test('asking for it as a download still gets a download', async () => {
    const up = await upload(srv.base, me.client.cookie, convo, WEBM, asVoice());
    const res = await fetch(`${srv.base}${up.body.attachment.url}?download=1`, {
      headers: { 'X-Relay-Client': '1', Cookie: me.client.cookie },
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/octet-stream');
    assert.match(res.headers.get('content-disposition'), /^attachment/);
  });

  test('a non-member cannot fetch one', async () => {
    const up = await upload(srv.base, me.client.cookie, convo, WEBM, asVoice());
    const stranger = await signUp(srv.base, 'Nosy Stranger', 'nosy@notes.test');
    const res = await fetch(`${srv.base}${up.body.attachment.url}`, {
      headers: { 'X-Relay-Client': '1', Cookie: stranger.client.cookie },
    });
    assert.ok(res.status === 403 || res.status === 404, `got ${res.status}`);
  });
});

describe('sending one', () => {
  test('a recording rides on a message like any other attachment', async () => {
    const up = await upload(srv.base, me.client.cookie, convo, WEBM, asVoice({ 'X-Relay-Duration': '5000' }));
    const sent = await me.client.post(`/api/conversations/${convo}/messages`, {
      text: '', attachmentIds: [up.body.attachment.id],
    });
    assert.equal(sent.status, 201);
    const [a] = sent.body.message.attachments;
    assert.equal(a.isVoice, true);
    assert.equal(a.durationMs, 5000);
  });

  test('it survives a round trip through history', async () => {
    const up = await upload(srv.base, me.client.cookie, convo, OGG, asVoice({ 'X-Relay-Duration': '1500' }));
    const sent = await me.client.post(`/api/conversations/${convo}/messages`, {
      text: 'listen', attachmentIds: [up.body.attachment.id],
    });
    const hist = await me.client.get(`/api/conversations/${convo}/messages?limit=50`);
    const found = hist.body.messages.find((msg) => msg.id === sent.body.message.id);
    assert.equal(found.attachments[0].isVoice, true);
    assert.equal(found.attachments[0].durationMs, 1500);
  });
});

describe('sniffAudioContainer', () => {
  test('recognises the three containers a recorder produces', () => {
    assert.equal(files.sniffAudioContainer(WEBM), 'audio/webm');
    assert.equal(files.sniffAudioContainer(OGG), 'audio/ogg');
    assert.equal(files.sniffAudioContainer(MP4), 'audio/mp4');
  });

  test('refuses everything else', () => {
    assert.equal(files.sniffAudioContainer(PNG), null);
    assert.equal(files.sniffAudioContainer(Buffer.from('plain text')), null);
    assert.equal(files.sniffAudioContainer(Buffer.alloc(0)), null);
    assert.equal(files.sniffAudioContainer(Buffer.from([0x1a, 0x45])), null);
  });

  test('is separate from the general sniffer, which still refuses audio', () => {
    // The whole point of the split: an ordinary upload of these bytes must not
    // start being served inline.
    assert.equal(files.sniffMime(WEBM), null);
    assert.equal(files.sniffMime(OGG), null);
    assert.equal(files.sniffMime(PNG), 'image/png');
  });

  test('only images and recordings are served inline', () => {
    assert.equal(files.isServedInline('image/png'), true);
    assert.equal(files.isServedInline('audio/webm'), true);
    assert.equal(files.isServedInline('audio/mp4'), true);
    assert.equal(files.isServedInline('text/html'), false);
    assert.equal(files.isServedInline('application/pdf'), false);
    assert.equal(files.isServedInline('image/svg+xml'), false);
    assert.equal(files.isServedInline('application/octet-stream'), false);
  });
});

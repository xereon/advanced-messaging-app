import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { startTestServer, signUp } from './helpers.js';
import { safeName, sniffMime, imageSize, MAX_FILE_BYTES } from '../server/files.js';
import { loginCodeEmail, isConfigured } from '../server/mailer.js';

let srv;
before(async () => { srv = await startTestServer(); });
after(async () => { await srv.stop(); });

/** A 1x1 PNG, valid enough to sniff and measure. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

async function upload(client, base, convoId, body, { name = 'photo.png', type = 'image/png' } = {}) {
  const res = await fetch(`${base}/api/conversations/${encodeURIComponent(convoId)}/attachments`, {
    method: 'POST',
    headers: {
      'X-Relay-Client': '1',
      'X-Relay-Filename': encodeURIComponent(name),
      'Content-Type': type,
      Cookie: client.cookie,
    },
    body,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : {} };
}

async function pair(tag) {
  const a = await signUp(srv.base, `A ${tag}`, `a-${tag}@files.test`);
  const b = await signUp(srv.base, `B ${tag}`, `b-${tag}@files.test`);
  const { body } = await a.client.post('/api/conversations', { type: 'dm', members: [b.user.id] });
  return { a, b, convo: body.conversation };
}

describe('file helpers', () => {
  test('filenames cannot escape a directory', () => {
    assert.equal(safeName('../../etc/passwd'), 'passwd');
    assert.equal(safeName('..\\..\\windows\\system32'), 'system32');
    assert.equal(safeName(''), 'file');
    assert.ok(!safeName('a/b/c.txt').includes('/'));
  });

  test('type is sniffed from content, not the claimed header', () => {
    assert.equal(sniffMime(PNG), 'image/png');
    assert.equal(sniffMime(Buffer.from('GIF89a....')), 'image/gif');
    assert.equal(sniffMime(Buffer.from('<?php echo 1; ?>')), null);
  });

  test('image dimensions are read from the header', () => {
    assert.deepEqual(imageSize(PNG, 'image/png'), { width: 1, height: 1 });
  });
});

describe('uploads', () => {
  test('an image uploads, attaches to a message and reaches the other member', async () => {
    const { a, b, convo } = await pair('img');
    const up = await upload(a.client, srv.base, convo.id, PNG);
    assert.equal(up.status, 201);
    assert.equal(up.body.attachment.isImage, true);
    assert.equal(up.body.attachment.mime, 'image/png');
    assert.equal(up.body.attachment.name, 'photo.png');

    const sent = await a.client.post(`/api/conversations/${encodeURIComponent(convo.id)}/messages`,
      { text: 'here it is', attachmentIds: [up.body.attachment.id] });
    assert.equal(sent.status, 201);
    assert.equal(sent.body.message.attachments.length, 1);

    const boot = await b.client.get('/api/bootstrap');
    const msg = boot.body.messages[convo.id].find((x) => x.id === sent.body.message.id);
    assert.equal(msg.attachments[0].name, 'photo.png');
  });

  test('a disguised script is stored as a plain download, not as its claimed type', async () => {
    const { a, convo } = await pair('disguise');
    const up = await upload(a.client, srv.base, convo.id, Buffer.from('<script>alert(1)</script>'),
      { name: 'evil.png', type: 'image/png' });
    assert.equal(up.status, 201);
    assert.equal(up.body.attachment.mime, 'application/octet-stream');
    assert.equal(up.body.attachment.isImage, false);
  });

  test('an empty file is refused', async () => {
    const { a, convo } = await pair('empty');
    const up = await upload(a.client, srv.base, convo.id, Buffer.alloc(0));
    assert.equal(up.status, 400);
  });

  test('an oversized file is refused', async () => {
    const { a, convo } = await pair('big');
    const up = await upload(a.client, srv.base, convo.id, Buffer.alloc(MAX_FILE_BYTES + 1024, 1));
    assert.equal(up.status, 413);
  });

  test('an outsider cannot upload to a conversation', async () => {
    const { convo } = await pair('upload-auth');
    const outsider = await signUp(srv.base, 'Outsider', 'outsider@files.test');
    const up = await upload(outsider.client, srv.base, convo.id, PNG);
    assert.equal(up.status, 403);
  });
});

describe('downloads', () => {
  test('members can fetch a file and outsiders cannot', async () => {
    const { a, b, convo } = await pair('download');
    const up = await upload(a.client, srv.base, convo.id, PNG);
    const id = up.body.attachment.id;

    const asMember = await fetch(`${srv.base}/api/attachments/${id}`, { headers: { Cookie: b.client.cookie } });
    assert.equal(asMember.status, 200);
    assert.equal(asMember.headers.get('content-type'), 'image/png');
    assert.match(asMember.headers.get('content-disposition'), /^inline/);
    assert.equal(asMember.headers.get('x-content-type-options'), 'nosniff');

    const outsider = await signUp(srv.base, 'Snooper', 'snooper@files.test');
    const denied = await fetch(`${srv.base}/api/attachments/${id}`, { headers: { Cookie: outsider.client.cookie } });
    assert.equal(denied.status, 403);

    const anonymous = await fetch(`${srv.base}/api/attachments/${id}`);
    assert.equal(anonymous.status, 401);
  });

  test('non-image files are served as downloads', async () => {
    const { a, convo } = await pair('doc');
    const up = await upload(a.client, srv.base, convo.id, Buffer.from('id,name\n1,test\n'),
      { name: 'data.csv', type: 'text/csv' });
    const res = await fetch(`${srv.base}/api/attachments/${up.body.attachment.id}`, {
      headers: { Cookie: a.client.cookie },
    });
    assert.equal(res.headers.get('content-type'), 'application/octet-stream');
    assert.match(res.headers.get('content-disposition'), /^attachment/);
  });

  test('deleting a message removes its files', async () => {
    const { a, convo } = await pair('cleanup');
    const up = await upload(a.client, srv.base, convo.id, PNG);
    const sent = await a.client.post(`/api/conversations/${encodeURIComponent(convo.id)}/messages`,
      { text: 'temporary', attachmentIds: [up.body.attachment.id] });

    await a.client.del(`/api/messages/${sent.body.message.id}`);
    const res = await fetch(`${srv.base}/api/attachments/${up.body.attachment.id}`, {
      headers: { Cookie: a.client.cookie },
    });
    assert.equal(res.status, 404);
  });

  test('an attachment cannot be claimed by someone else', async () => {
    const { a, b, convo } = await pair('claim');
    const up = await upload(a.client, srv.base, convo.id, PNG);
    const stolen = await b.client.post(`/api/conversations/${encodeURIComponent(convo.id)}/messages`,
      { text: 'not mine', attachmentIds: [up.body.attachment.id] });
    assert.equal(stolen.body.message.attachments.length, 0);
  });
});

describe('message history paging', () => {
  test('older messages are fetched a page at a time', async () => {
    const { a, convo } = await pair('paging');
    const url = `/api/conversations/${encodeURIComponent(convo.id)}/messages`;
    for (let i = 0; i < 12; i++) {
      await a.client.post(url, { text: `message ${i}` });
    }

    const firstPage = await a.client.get(`${url}?limit=5`);
    assert.equal(firstPage.body.messages.length, 5);
    assert.equal(firstPage.body.hasMore, true);
    assert.equal(firstPage.body.messages.at(-1).text, 'message 11');

    const older = await a.client.get(`${url}?limit=5&before=${firstPage.body.messages[0].seq}`);
    assert.equal(older.body.messages.length, 5);
    assert.equal(older.body.messages.at(-1).text, 'message 6');

    // Pages must not overlap.
    const firstIds = new Set(firstPage.body.messages.map((x) => x.id));
    assert.ok(older.body.messages.every((x) => !firstIds.has(x.id)));

    const oldest = await a.client.get(`${url}?limit=50&before=${older.body.messages[0].seq}`);
    assert.equal(oldest.body.hasMore, false);
  });

  test('an outsider cannot page through someone else’s history', async () => {
    const { convo } = await pair('paging-auth');
    const outsider = await signUp(srv.base, 'Pager', 'pager@files.test');
    const res = await outsider.client.get(`/api/conversations/${encodeURIComponent(convo.id)}/messages?limit=5`);
    assert.equal(res.status, 403);
  });
});

describe('mail transport', () => {
  test('reports itself unconfigured when no host is set', () => {
    assert.equal(isConfigured(), false);
  });

  test('the login-code email carries the code and escapes the name', () => {
    const mail = loginCodeEmail('<script>Bad</script>', '123456');
    assert.match(mail.subject, /123456/);
    assert.match(mail.text, /123456/);
    assert.ok(!mail.html.includes('<script>'));
    assert.match(mail.text, /expires in 10 minutes/i);
  });

  test('without a transport the code is returned for the on-screen inbox', async () => {
    await signUp(srv.base, 'Code Fallback', 'fallback@files.test');
    const { client } = await signUp(srv.base, 'Requester', 'requester@files.test');
    const res = await client.post('/api/auth/code/request', { email: 'fallback@files.test' });
    assert.equal(res.body.delivery, 'demo-inbox');
    assert.match(res.body.code, /^\d{6}$/);
  });
});

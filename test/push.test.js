// Web Push, verified by decrypting what the server produces exactly as a
// browser would, and by checking the VAPID JWT against the key we advertise.
// Both halves are real cryptography; a mistake in either is silent — the push
// service simply refuses, or the browser cannot read the payload.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  createECDH, hkdfSync, createDecipheriv, randomBytes, createVerify, createPublicKey,
} from 'node:crypto';

import { startTestServer, signUp } from './helpers.js';
import * as push from '../server/push.js';

let srv;
before(async () => { srv = await startTestServer(); });
after(async () => { await srv.stop(); });

/** A stand-in for the browser's end of a subscription. */
function fakeBrowserSubscription() {
  const ua = createECDH('prime256v1');
  ua.generateKeys();
  const authSecret = randomBytes(16);
  return {
    p256dh: ua.getPublicKey().toString('base64url'),
    auth: authSecret.toString('base64url'),
    /** Decrypt an aes128gcm body, per RFC 8291. */
    decrypt(sealed) {
      const salt = sealed.subarray(0, 16);
      const idlen = sealed.readUInt8(20);
      const asPublic = sealed.subarray(21, 21 + idlen);
      const body = sealed.subarray(21 + idlen);

      const shared = ua.computeSecret(asPublic);
      const keyInfo = Buffer.concat([
        Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPublic,
      ]);
      const ikm = Buffer.from(hkdfSync('sha256', shared, authSecret, keyInfo, 32));
      const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
      const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));

      const tag = body.subarray(body.length - 16);
      const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
      decipher.setAuthTag(tag);
      const out = Buffer.concat([
        decipher.update(body.subarray(0, body.length - 16)),
        decipher.final(),
      ]);
      // Strip the record delimiter.
      return out.subarray(0, out.length - 1).toString('utf8');
    },
  };
}

describe('payload encryption', () => {
  test('a browser can decrypt what the server sealed', () => {
    const browser = fakeBrowserSubscription();
    const payload = JSON.stringify({ title: 'Ada', body: 'the pelican memo is ready' });
    const sealed = push.encryptPayload(payload, browser.p256dh, browser.auth);
    assert.equal(browser.decrypt(sealed), payload);
  });

  test('the body carries the salt, record size and server key, as the spec requires', () => {
    const browser = fakeBrowserSubscription();
    const sealed = push.encryptPayload('hello', browser.p256dh, browser.auth);
    assert.equal(sealed.readUInt32BE(16), 4096, 'record size');
    assert.equal(sealed.readUInt8(20), 65, 'uncompressed P-256 point length');
    assert.equal(sealed.subarray(21, 22).readUInt8(0), 0x04, 'the key must be uncompressed');
  });

  test('each message uses a fresh key and salt', () => {
    const browser = fakeBrowserSubscription();
    const a = push.encryptPayload('same text', browser.p256dh, browser.auth);
    const b = push.encryptPayload('same text', browser.p256dh, browser.auth);
    assert.notDeepEqual(a.subarray(0, 16), b.subarray(0, 16), 'salt must not repeat');
    assert.notDeepEqual(a.subarray(21, 86), b.subarray(21, 86), 'server key must not repeat');
    assert.equal(browser.decrypt(a), 'same text');
    assert.equal(browser.decrypt(b), 'same text');
  });

  test('another subscription cannot read it', () => {
    const intended = fakeBrowserSubscription();
    const eavesdropper = fakeBrowserSubscription();
    const sealed = push.encryptPayload('for one person only', intended.p256dh, intended.auth);
    assert.throws(() => eavesdropper.decrypt(sealed));
  });

  test('a malformed subscription key is refused', () => {
    assert.throws(
      () => push.encryptPayload('x', Buffer.alloc(10).toString('base64url'), randomBytes(16).toString('base64url')),
      /uncompressed P-256/,
    );
  });
});

describe('VAPID', () => {
  test('the JWT verifies against the advertised public key', () => {
    const header = push.vapidAuthorization('https://fcm.googleapis.com/fcm/send/abc123');
    const token = /t=([^,]+)/.exec(header)[1];
    const advertised = /k=([^,\s]+)/.exec(header)[1];
    assert.equal(advertised, push.publicKey(), 'the header must advertise the signing key');

    const [h, c, sig] = token.split('.');
    const point = Buffer.from(push.publicKey(), 'base64url');
    const key = createPublicKey({
      key: {
        kty: 'EC', crv: 'P-256',
        x: point.subarray(1, 33).toString('base64url'),
        y: point.subarray(33, 65).toString('base64url'),
      },
      format: 'jwk',
    });
    const verifier = createVerify('sha256');
    verifier.update(`${h}.${c}`);
    // JOSE signatures are raw r‖s, not DER.
    assert.equal(
      verifier.verify({ key, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url')),
      true,
    );
  });

  test('the audience is the push service origin, and it expires', () => {
    const header = push.vapidAuthorization('https://updates.push.services.mozilla.com/wpush/v2/xyz');
    const claims = JSON.parse(
      Buffer.from(/t=([^,]+)/.exec(header)[1].split('.')[1], 'base64url').toString(),
    );
    assert.equal(claims.aud, 'https://updates.push.services.mozilla.com');
    assert.ok(claims.exp > Math.floor(Date.now() / 1000), 'must not be already expired');
    assert.ok(claims.exp <= Math.floor(Date.now() / 1000) + 24 * 60 * 60, 'and must be short-lived');
    assert.match(claims.sub, /^mailto:/);
  });

  test('the signature is raw r‖s, 64 bytes', () => {
    const token = /t=([^,]+)/.exec(push.vapidAuthorization('https://example.com/push/1'))[1];
    assert.equal(Buffer.from(token.split('.')[2], 'base64url').length, 64);
  });

  test('the identity is stable across calls', () => {
    assert.equal(push.publicKey(), push.publicKey());
  });
});

describe('subscriptions', () => {
  test('a device can register, and re-registering is idempotent', async () => {
    const { client: c } = await signUp(srv.base, 'Push One', 'push1@push.test');
    const browser = fakeBrowserSubscription();
    const body = {
      endpoint: 'https://fcm.googleapis.com/fcm/send/device-one',
      keys: { p256dh: browser.p256dh, auth: browser.auth },
    };
    assert.equal((await c.post('/api/push/subscribe', body)).status, 201);
    assert.equal((await c.post('/api/push/subscribe', body)).status, 201);
    assert.equal(push.subscriptionsFor((await c.get('/api/me')).body.user.id).length, 1);
  });

  test('several devices are kept separately', async () => {
    const { client: c, user } = await signUp(srv.base, 'Push Many', 'pushmany@push.test');
    const browser = fakeBrowserSubscription();
    for (const name of ['laptop', 'phone']) {
      await c.post('/api/push/subscribe', {
        endpoint: `https://fcm.googleapis.com/fcm/send/${name}`,
        keys: { p256dh: browser.p256dh, auth: browser.auth },
      });
    }
    assert.equal(push.subscriptionsFor(user.id).length, 2);
  });

  test('unsubscribing removes only that device', async () => {
    const { client: c, user } = await signUp(srv.base, 'Push Off', 'pushoff@push.test');
    const browser = fakeBrowserSubscription();
    for (const name of ['keep', 'drop']) {
      await c.post('/api/push/subscribe', {
        endpoint: `https://fcm.googleapis.com/fcm/send/${name}`,
        keys: { p256dh: browser.p256dh, auth: browser.auth },
      });
    }
    await c.del('/api/push/subscribe', { endpoint: 'https://fcm.googleapis.com/fcm/send/drop' });
    const left = push.subscriptionsFor(user.id);
    assert.equal(left.length, 1);
    assert.match(left[0].endpoint, /keep$/);
  });

  test('a non-https endpoint and a keyless subscription are refused', async () => {
    const { client: c } = await signUp(srv.base, 'Push Bad', 'pushbad@push.test');
    const browser = fakeBrowserSubscription();
    assert.equal((await c.post('/api/push/subscribe', {
      endpoint: 'http://insecure.example/push', keys: { p256dh: browser.p256dh, auth: browser.auth },
    })).status, 400);
    assert.equal((await c.post('/api/push/subscribe', {
      endpoint: 'https://fcm.googleapis.com/fcm/send/x', keys: {},
    })).status, 400);
  });

  test('one account cannot remove another account’s device', async () => {
    const a = await signUp(srv.base, 'Push Owner', 'pushowner@push.test');
    const b = await signUp(srv.base, 'Push Thief', 'pushthief@push.test');
    const browser = fakeBrowserSubscription();
    const endpoint = 'https://fcm.googleapis.com/fcm/send/owned';
    await a.client.post('/api/push/subscribe', { endpoint, keys: { p256dh: browser.p256dh, auth: browser.auth } });

    await b.client.del('/api/push/subscribe', { endpoint });
    assert.equal(push.subscriptionsFor(a.user.id).length, 1, 'it must still belong to its owner');
  });

  test('the key and subscribe endpoints need a session', async () => {
    assert.equal((await fetch(`${srv.base}/api/push/key`)).status, 401);
    const res = await fetch(`${srv.base}/api/push/subscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Relay-Client': '1' },
      body: JSON.stringify({ endpoint: 'https://x/y', keys: { p256dh: 'a', auth: 'b' } }),
    });
    assert.equal(res.status, 401);
  });

  test('a dead endpoint is dropped rather than retried forever', async () => {
    const { client: c, user } = await signUp(srv.base, 'Push Gone', 'pushgone@push.test');
    const browser = fakeBrowserSubscription();
    // 410 Gone is what a push service returns for a discarded subscription.
    const endpoint = 'https://httpbin.invalid/gone';
    await c.post('/api/push/subscribe', { endpoint, keys: { p256dh: browser.p256dh, auth: browser.auth } });

    // An unreachable host counts as a failure; five of them retire the endpoint.
    for (let i = 0; i < 5; i++) {
      await push.deliver(push.subscriptionsFor(user.id)[0] || { endpoint, p256dh: browser.p256dh, auth: browser.auth }, { title: 'x' });
      if (!push.subscriptionsFor(user.id).length) break;
    }
    assert.equal(push.subscriptionsFor(user.id).length, 0, 'a repeatedly failing device is forgotten');
  });
});

describe('the client and worker are wired for push', () => {
  const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

  test('the service worker shows notifications and handles the click', () => {
    const sw = read('../public/sw.js');
    assert.match(sw, /addEventListener\('push'/);
    assert.match(sw, /showNotification/);
    assert.match(sw, /addEventListener\('notificationclick'/);
    assert.match(sw, /clients\.matchAll/, 'clicking should focus an open tab, not always open a new one');
  });

  test('the client subscribes with the server’s key', () => {
    const store = read('../public/js/store.js');
    assert.match(store, /pushManager\.subscribe/);
    assert.match(store, /applicationServerKey/);
    assert.match(store, /userVisibleOnly: true/);
  });

  test('turning notifications on registers the device', () => {
    assert.match(read('../public/js/ui.js'), /db\.enablePush\(\)/);
    assert.match(read('../public/js/ui.js'), /db\.disablePush\(\)/);
  });

  test('oversized photos are downscaled before upload', () => {
    const api = read('../public/js/api.js');
    assert.match(api, /export async function shrinkImage/);
    assert.match(api, /createImageBitmap/);
    assert.match(api, /const file = await shrinkImage\(original\)/);
  });

  test('the message list is windowed so the DOM stays bounded', () => {
    const ui = read('../public/js/ui.js');
    assert.match(ui, /const RENDER_WINDOW = \d+/);
    assert.match(ui, /all\.slice\(-renderWindow\)/);
  });
});

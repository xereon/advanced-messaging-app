// push.js — Web Push, with no dependencies.
//
// Two pieces of cryptography are required and neither is optional:
//
//   VAPID (RFC 8292) proves to the push service who is sending. It is an ES256
//   JWT over {aud, exp, sub}, plus the public key in the Authorization header.
//
//   Payload encryption (RFC 8291, content coding aes128gcm from RFC 8188) means
//   the push service relays a body it cannot read. The browser hands us its
//   public key and an auth secret at subscribe time; we do an ECDH against a
//   fresh key pair, derive a content key with HKDF, and seal with AES-128-GCM.
//
// Keys live in the database so a fresh install works with no configuration and
// keeps the same identity across restarts — rotating them would silently
// invalidate every existing subscription.

import {
  createECDH, createSign, createHmac, hkdfSync, randomBytes,
  createCipheriv, generateKeyPairSync, createPublicKey, createPrivateKey,
} from 'node:crypto';

import { handle } from './db.js';

const CURVE = 'prime256v1';
const JWT_TTL_S = 12 * 60 * 60;
const RECORD_SIZE = 4096;
/** A push service that fails this many times in a row has a dead endpoint. */
const MAX_FAILURES = 5;

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const fromB64url = (str) => Buffer.from(String(str), 'base64url');

/* ---------- identity ---------- */

function readConfig(key) {
  try {
    return handle().prepare('SELECT value FROM config WHERE key = ?').get(key)?.value ?? null;
  } catch { return null; }
}

function writeConfig(key, value) {
  handle().prepare(
    'INSERT INTO config (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, value);
}

/** Generate a VAPID key pair in the form the spec and the browser expect. */
export function generateVapidKeys() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: CURVE });
  const jwk = privateKey.export({ format: 'jwk' });
  // The browser wants the uncompressed public point, not SPKI.
  const point = Buffer.concat([
    Buffer.from([0x04]),
    Buffer.from(jwk.x, 'base64url'),
    Buffer.from(jwk.y, 'base64url'),
  ]);
  return { publicKey: b64url(point), privateKey: jwk.d, _pem: { publicKey, privateKey } };
}

/**
 * The server's push identity. Environment wins so a deployment can pin it;
 * otherwise one is minted once and reused.
 */
export function vapidKeys() {
  const fromEnv = process.env.RELAY_VAPID_PUBLIC && process.env.RELAY_VAPID_PRIVATE;
  if (fromEnv) {
    return { publicKey: process.env.RELAY_VAPID_PUBLIC, privateKey: process.env.RELAY_VAPID_PRIVATE };
  }
  const stored = readConfig('vapid_public');
  const storedPrivate = readConfig('vapid_private');
  if (stored && storedPrivate) return { publicKey: stored, privateKey: storedPrivate };

  const fresh = generateVapidKeys();
  writeConfig('vapid_public', fresh.publicKey);
  writeConfig('vapid_private', fresh.privateKey);
  return { publicKey: fresh.publicKey, privateKey: fresh.privateKey };
}

export const publicKey = () => vapidKeys().publicKey;

export const subject = () => process.env.RELAY_VAPID_SUBJECT || 'mailto:admin@localhost';

/* ---------- VAPID JWT ---------- */

/** ECDSA signatures come out DER-encoded; JOSE wants raw r‖s. */
function derToJose(der) {
  let offset = 2;
  if (der[1] & 0x80) offset += der[1] & 0x7f;   // long-form length
  const readInt = () => {
    if (der[offset] !== 0x02) throw new Error('Malformed DER signature.');
    const len = der[offset + 1];
    let start = offset + 2;
    let end = start + len;
    // Strip the sign byte DER adds, then left-pad to the curve size.
    while (der[start] === 0x00 && end - start > 1) start += 1;
    const value = der.subarray(start, end);
    offset = end;
    return Buffer.concat([Buffer.alloc(32 - value.length, 0), value]);
  };
  const r = readInt();
  const s = readInt();
  return Buffer.concat([r, s]);
}

function privateKeyObject(d) {
  const pub = fromB64url(vapidKeys().publicKey);
  return createPrivateKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      d,
      x: b64url(pub.subarray(1, 33)),
      y: b64url(pub.subarray(33, 65)),
    },
    format: 'jwk',
  });
}

export function vapidAuthorization(endpoint) {
  const { publicKey: pub, privateKey: priv } = vapidKeys();
  const audience = new URL(endpoint).origin;

  const header = b64url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64url(JSON.stringify({
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + JWT_TTL_S,
    sub: subject(),
  }));
  const signingInput = `${header}.${claims}`;

  const signer = createSign('sha256');
  signer.update(signingInput);
  const signature = b64url(derToJose(signer.sign(privateKeyObject(priv))));

  return `vapid t=${signingInput}.${signature}, k=${pub}`;
}

/* ---------- payload encryption (RFC 8291) ---------- */

export function encryptPayload(plaintext, uaPublicB64, authSecretB64) {
  const uaPublic = fromB64url(uaPublicB64);
  const authSecret = fromB64url(authSecretB64);
  if (uaPublic.length !== 65) throw new Error('Subscription key is not an uncompressed P-256 point.');

  const ecdh = createECDH(CURVE);
  ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(uaPublic);

  // The key info binds the derived secret to both parties' public keys, so a
  // captured payload cannot be replayed against a different subscription.
  const keyInfo = Buffer.concat([
    Buffer.from('WebPush: info\0', 'utf8'), uaPublic, asPublic,
  ]);
  const ikm = Buffer.from(hkdfSync('sha256', shared, authSecret, keyInfo, 32));

  const salt = randomBytes(16);
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0', 'utf8'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0', 'utf8'), 12));

  // A single record, so the padding delimiter is 0x02 ("last record").
  const padded = Buffer.concat([Buffer.from(plaintext, 'utf8'), Buffer.from([0x02])]);
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const sealed = Buffer.concat([cipher.update(padded), cipher.final(), cipher.getAuthTag()]);

  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header.writeUInt8(asPublic.length, 20);

  return Buffer.concat([header, asPublic, sealed]);
}

/* ---------- subscriptions ---------- */

export function saveSubscription(userId, { endpoint, keys }) {
  if (!endpoint || !/^https:\/\//.test(endpoint)) {
    const e = new Error('A push endpoint must be an https URL.');
    e.status = 400;
    throw e;
  }
  if (!keys?.p256dh || !keys?.auth) {
    const e = new Error('The subscription is missing its keys.');
    e.status = 400;
    throw e;
  }
  handle().prepare(
    `INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth, created_at, failures)
     VALUES (?,?,?,?,?,0)
     ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id,
       p256dh = excluded.p256dh, auth = excluded.auth, failures = 0`,
  ).run(endpoint, userId, keys.p256dh, keys.auth, Date.now());
  return { ok: true };
}

export function removeSubscription(userId, endpoint) {
  handle().prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?')
    .run(endpoint, userId);
  return { ok: true };
}

export function subscriptionsFor(userId) {
  try {
    return handle().prepare('SELECT * FROM push_subscriptions WHERE user_id = ?').all(userId);
  } catch { return []; }
}

function forget(endpoint) {
  try { handle().prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint); }
  catch { /* nothing to do */ }
}

function noteFailure(endpoint) {
  try {
    handle().prepare('UPDATE push_subscriptions SET failures = failures + 1 WHERE endpoint = ?').run(endpoint);
    const row = handle().prepare('SELECT failures FROM push_subscriptions WHERE endpoint = ?').get(endpoint);
    if (row && row.failures >= MAX_FAILURES) forget(endpoint);
  } catch { /* nothing to do */ }
}

/* ---------- delivery ---------- */

/** Deliver one notification. Resolves to true when the service accepted it. */
export async function deliver(subscription, payload) {
  const body = encryptPayload(JSON.stringify(payload), subscription.p256dh, subscription.auth);
  let res;
  try {
    res = await fetch(subscription.endpoint, {
      method: 'POST',
      headers: {
        Authorization: vapidAuthorization(subscription.endpoint),
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        TTL: '2419200',
        Urgency: 'high',
      },
      body,
    });
  } catch {
    noteFailure(subscription.endpoint);
    return false;
  }

  // 404 and 410 mean the browser threw the subscription away; stop trying.
  if (res.status === 404 || res.status === 410) {
    forget(subscription.endpoint);
    return false;
  }
  if (!res.ok) {
    noteFailure(subscription.endpoint);
    return false;
  }
  try {
    handle().prepare('UPDATE push_subscriptions SET failures = 0 WHERE endpoint = ?')
      .run(subscription.endpoint);
  } catch { /* not important */ }
  return true;
}

/** Notify one person on every device they have registered. */
export async function notify(userId, payload) {
  const subs = subscriptionsFor(userId);
  if (!subs.length) return 0;
  const results = await Promise.all(subs.map((s) => deliver(s, payload).catch(() => false)));
  return results.filter(Boolean).length;
}

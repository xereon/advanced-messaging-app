import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  createHash, generateKeyPairSync, sign as cryptoSign, randomBytes,
} from 'node:crypto';

import { decode } from '../server/cbor.js';
import {
  parseAuthData, coseToPublicKey, verifyRegistration, verifyAuthentication,
  registrationOptions, authenticationOptions,
} from '../server/webauthn.js';

const RP_ID = 'localhost';
const ORIGIN = 'http://localhost:8130';
const b64url = (b) => Buffer.from(b).toString('base64url');

/* ---------- a minimal CBOR encoder, used only to build test fixtures ---------- */

function cborHead(major, arg) {
  if (arg < 24) return Buffer.from([(major << 5) | arg]);
  if (arg < 256) return Buffer.from([(major << 5) | 24, arg]);
  if (arg < 65536) { const b = Buffer.alloc(3); b[0] = (major << 5) | 25; b.writeUInt16BE(arg, 1); return b; }
  const b = Buffer.alloc(5); b[0] = (major << 5) | 26; b.writeUInt32BE(arg, 1); return b;
}
function cborItem(v) {
  if (typeof v === 'number' && Number.isInteger(v)) return v >= 0 ? cborHead(0, v) : cborHead(1, -1 - v);
  if (Buffer.isBuffer(v)) return Buffer.concat([cborHead(2, v.length), v]);
  if (typeof v === 'string') { const b = Buffer.from(v, 'utf8'); return Buffer.concat([cborHead(3, b.length), b]); }
  if (v instanceof Map) {
    const parts = [cborHead(5, v.size)];
    for (const [k, val] of v) { parts.push(cborItem(k)); parts.push(cborItem(val)); }
    return Buffer.concat(parts);
  }
  throw new Error('unsupported test value');
}

/* ---------- a fake authenticator ---------- */

function makeAuthenticator() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const cose = new Map([
    [1, 2],                                     // kty: EC2
    [3, -7],                                    // alg: ES256
    [-1, 1],                                    // crv: P-256
    [-2, Buffer.from(jwk.x, 'base64url')],
    [-3, Buffer.from(jwk.y, 'base64url')],
  ]);
  const credentialId = randomBytes(32);

  const authData = (signCount, { includeCredential = false, rpId = RP_ID, flags = 0x05 } = {}) => {
    const rpIdHash = createHash('sha256').update(rpId).digest();
    const head = Buffer.alloc(5);
    head[0] = includeCredential ? flags | 0x40 : flags;
    head.writeUInt32BE(signCount, 1);
    const base = Buffer.concat([rpIdHash, head]);
    if (!includeCredential) return base;
    const lenBuf = Buffer.alloc(2);
    lenBuf.writeUInt16BE(credentialId.length);
    return Buffer.concat([base, Buffer.alloc(16), lenBuf, credentialId, cborItem(cose)]);
  };

  return {
    credentialId,
    register(challenge, { rpId = RP_ID, origin = ORIGIN } = {}) {
      const clientDataJSON = Buffer.from(JSON.stringify({
        type: 'webauthn.create', challenge, origin, crossOrigin: false,
      }));
      const attestationObject = cborItem(new Map([
        ['fmt', 'none'],
        ['attStmt', new Map()],
        ['authData', authData(0, { includeCredential: true, rpId })],
      ]));
      return { clientDataJSON: b64url(clientDataJSON), attestationObject: b64url(attestationObject) };
    },
    authenticate(challenge, { signCount = 1, origin = ORIGIN, tamper = false } = {}) {
      const clientDataJSON = Buffer.from(JSON.stringify({
        type: 'webauthn.get', challenge, origin, crossOrigin: false,
      }));
      const ad = authData(signCount);
      const signed = Buffer.concat([ad, createHash('sha256').update(clientDataJSON).digest()]);
      const signature = cryptoSign('sha256', tamper ? Buffer.concat([signed, Buffer.from('x')]) : signed, privateKey);
      return {
        clientDataJSON: b64url(clientDataJSON),
        authenticatorData: b64url(ad),
        signature: b64url(signature),
      };
    },
  };
}

/* ---------- tests ---------- */

describe('CBOR decoding', () => {
  test('round-trips the shapes WebAuthn uses', () => {
    const map = new Map([[1, 2], [-1, 1], ['authData', Buffer.from('hello')], [3, -7]]);
    const decoded = decode(cborItem(map));
    assert.equal(decoded.get(1), 2);
    assert.equal(decoded.get(-1), 1);
    assert.equal(decoded.get(3), -7);
    assert.equal(decoded.get('authData').toString(), 'hello');
  });

  test('handles multi-byte lengths', () => {
    const big = Buffer.alloc(400, 7);
    assert.equal(decode(cborItem(big)).length, 400);
  });

  test('rejects truncated input', () => {
    assert.throws(() => decode(Buffer.from([0x58, 0x20, 0x01])), /unexpected end/i);
  });
});

describe('authenticator data', () => {
  test('parses flags, counter and the embedded credential', () => {
    const auth = makeAuthenticator();
    const reg = auth.register('abc');
    const attestation = decode(Buffer.from(reg.attestationObject, 'base64url'));
    const parsed = parseAuthData(attestation.get('authData'));

    assert.equal(parsed.userPresent, true);
    assert.equal(parsed.userVerified, true);
    assert.equal(parsed.attestedCredentialData, true);
    assert.ok(parsed.credentialId.equals(auth.credentialId));
    assert.ok(coseToPublicKey(parsed.credentialPublicKey).key);
  });

  test('rejects data that is too short', () => {
    assert.throws(() => parseAuthData(Buffer.alloc(10)), /too short/i);
  });
});

describe('registration', () => {
  const auth = makeAuthenticator();

  test('accepts a well-formed response', () => {
    const challenge = 'reg-challenge-1';
    const result = verifyRegistration({
      ...auth.register(challenge),
      expectedChallenge: challenge,
      expectedOrigins: [ORIGIN],
      rpId: RP_ID,
    });
    assert.equal(result.credentialId, b64url(auth.credentialId));
    assert.equal(result.alg, -7);
    assert.ok(result.publicKey);
  });

  test('rejects a replayed or mismatched challenge', () => {
    assert.throws(() => verifyRegistration({
      ...auth.register('challenge-a'),
      expectedChallenge: 'challenge-b',
      expectedOrigins: [ORIGIN],
      rpId: RP_ID,
    }), /challenge/i);
  });

  test('rejects a foreign origin', () => {
    const challenge = 'reg-challenge-2';
    assert.throws(() => verifyRegistration({
      ...auth.register(challenge, { origin: 'https://evil.example' }),
      expectedChallenge: challenge,
      expectedOrigins: [ORIGIN],
      rpId: RP_ID,
    }), /origin/i);
  });

  test('rejects a credential registered for another site', () => {
    const challenge = 'reg-challenge-3';
    assert.throws(() => verifyRegistration({
      ...auth.register(challenge, { rpId: 'attacker.example' }),
      expectedChallenge: challenge,
      expectedOrigins: [ORIGIN],
      rpId: RP_ID,
    }), /different site/i);
  });
});

describe('authentication', () => {
  const auth = makeAuthenticator();
  const registered = verifyRegistration({
    ...auth.register('setup'),
    expectedChallenge: 'setup',
    expectedOrigins: [ORIGIN],
    rpId: RP_ID,
  });

  const base = {
    expectedOrigins: [ORIGIN],
    rpId: RP_ID,
    storedPublicKey: registered.publicKey,
    storedSignCount: 0,
  };

  test('accepts a genuine signature', () => {
    const challenge = 'login-1';
    const result = verifyAuthentication({
      ...auth.authenticate(challenge, { signCount: 5 }),
      expectedChallenge: challenge,
      ...base,
    });
    assert.equal(result.signCount, 5);
    assert.equal(result.userVerified, true);
  });

  test('rejects a tampered signature', () => {
    const challenge = 'login-2';
    assert.throws(() => verifyAuthentication({
      ...auth.authenticate(challenge, { tamper: true }),
      expectedChallenge: challenge,
      ...base,
    }), /signature/i);
  });

  test('rejects a signature from a different key', () => {
    const impostor = makeAuthenticator();
    const challenge = 'login-3';
    assert.throws(() => verifyAuthentication({
      ...impostor.authenticate(challenge),
      expectedChallenge: challenge,
      ...base,
    }), /signature/i);
  });

  test('rejects a replayed challenge', () => {
    assert.throws(() => verifyAuthentication({
      ...auth.authenticate('the-real-challenge'),
      expectedChallenge: 'a-different-challenge',
      ...base,
    }), /challenge/i);
  });

  test('rejects a stalled signature counter, which suggests a clone', () => {
    const challenge = 'login-4';
    assert.throws(() => verifyAuthentication({
      ...auth.authenticate(challenge, { signCount: 3 }),
      expectedChallenge: challenge,
      ...base,
      storedSignCount: 9,
    }), /counter/i);
  });

  test('tolerates authenticators that always report zero', () => {
    const challenge = 'login-5';
    const result = verifyAuthentication({
      ...auth.authenticate(challenge, { signCount: 0 }),
      expectedChallenge: challenge,
      ...base,
      storedSignCount: 0,
    });
    assert.equal(result.signCount, 0);
  });
});

describe('ceremony options', () => {
  test('registration options advertise only algorithms we verify', () => {
    const opts = registrationOptions({
      user: { id: 'u-1', name: 'Test', email: 't@example.com' },
      rpId: RP_ID,
      rpName: 'Relay',
    });
    assert.deepEqual(opts.pubKeyCredParams.map((p) => p.alg), [-7, -257]);
    assert.equal(opts.rp.id, RP_ID);
    assert.ok(opts.challenge.length >= 43);
  });

  test('authentication options are discoverable by default', () => {
    const opts = authenticationOptions({ rpId: RP_ID });
    assert.deepEqual(opts.allowCredentials, []);
    assert.equal(opts.rpId, RP_ID);
  });

  test('two challenges are never the same', () => {
    const a = authenticationOptions({ rpId: RP_ID }).challenge;
    const b = authenticationOptions({ rpId: RP_ID }).challenge;
    assert.notEqual(a, b);
  });
});

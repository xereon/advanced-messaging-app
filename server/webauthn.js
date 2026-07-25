// webauthn.js — real WebAuthn: the server issues challenges, parses the
// authenticator's response and verifies the signature against the credential's
// stored public key. Nothing here trusts the client's word about success.
//
// Supported algorithms: ES256 (-7) and RS256 (-257), which between them cover
// every mainstream platform and roaming authenticator.

import { createHash, createPublicKey, verify as cryptoVerify, randomBytes } from 'node:crypto';
import { decode } from './cbor.js';

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const fromB64url = (str) => Buffer.from(String(str), 'base64url');
const sha256 = (buf) => createHash('sha256').update(buf).digest();

export const ES256 = -7;
export const RS256 = -257;
export const SUPPORTED_ALGS = [ES256, RS256];

export function newChallenge() { return b64url(randomBytes(32)); }

/* ---------- authenticator data ---------- */

/**
 * authData layout:
 *   rpIdHash(32) | flags(1) | signCount(4) | [attestedCredentialData] | [extensions]
 * attestedCredentialData:
 *   aaguid(16) | credentialIdLength(2) | credentialId | credentialPublicKey (COSE)
 */
export function parseAuthData(authData) {
  const buf = Buffer.from(authData);
  if (buf.length < 37) throw new Error('Authenticator data is too short.');

  const rpIdHash = buf.subarray(0, 32);
  const flags = buf[32];
  const signCount = buf.readUInt32BE(33);

  const out = {
    rpIdHash,
    flags,
    signCount,
    userPresent: !!(flags & 0x01),
    userVerified: !!(flags & 0x04),
    attestedCredentialData: !!(flags & 0x40),
    extensionData: !!(flags & 0x80),
  };

  if (!out.attestedCredentialData) return out;
  if (buf.length < 55) throw new Error('Attested credential data is truncated.');

  const credIdLen = buf.readUInt16BE(53);
  const credIdEnd = 55 + credIdLen;
  if (buf.length < credIdEnd) throw new Error('Credential id is truncated.');

  out.aaguid = buf.subarray(37, 53);
  out.credentialId = buf.subarray(55, credIdEnd);
  out.credentialPublicKey = decode(buf.subarray(credIdEnd));
  return out;
}

/* ---------- COSE keys ---------- */

/** Turn a COSE_Key map into a node KeyObject we can verify with. */
export function coseToPublicKey(cose) {
  if (!(cose instanceof Map)) throw new Error('Credential public key is malformed.');
  const kty = cose.get(1);
  const alg = cose.get(3);

  if (kty === 2) { // EC2
    if (alg !== ES256) throw new Error(`Unsupported elliptic-curve algorithm ${alg}.`);
    if (cose.get(-1) !== 1) throw new Error('Only the P-256 curve is supported.');
    const x = cose.get(-2);
    const y = cose.get(-3);
    if (!Buffer.isBuffer(x) || !Buffer.isBuffer(y) || x.length !== 32 || y.length !== 32) {
      throw new Error('Malformed EC public key.');
    }
    return {
      alg,
      key: createPublicKey({
        key: { kty: 'EC', crv: 'P-256', x: b64url(x), y: b64url(y) },
        format: 'jwk',
      }),
    };
  }

  if (kty === 3) { // RSA
    if (alg !== RS256) throw new Error(`Unsupported RSA algorithm ${alg}.`);
    const n = cose.get(-1);
    const e = cose.get(-2);
    if (!Buffer.isBuffer(n) || !Buffer.isBuffer(e)) throw new Error('Malformed RSA public key.');
    return {
      alg,
      key: createPublicKey({
        key: { kty: 'RSA', n: b64url(n), e: b64url(e) },
        format: 'jwk',
      }),
    };
  }

  throw new Error(`Unsupported key type ${kty}.`);
}

function verifySignature({ alg, key }, data, signature) {
  // WebAuthn ECDSA signatures are DER-encoded, which is node's default.
  const digest = alg === RS256 ? 'sha256' : 'sha256';
  return cryptoVerify(digest, data, key, Buffer.from(signature));
}

/* ---------- shared checks ---------- */

function checkClientData(clientDataJSON, { expectedType, expectedChallenge, expectedOrigins }) {
  let parsed;
  try {
    // The client sends this base64url-encoded, exactly as the authenticator
    // produced it, so the hash we verify covers the same bytes.
    parsed = JSON.parse(fromB64url(clientDataJSON).toString('utf8'));
  } catch {
    throw new Error('Client data is not valid JSON.');
  }
  if (parsed.type !== expectedType) {
    throw new Error(`Unexpected ceremony type ${parsed.type}.`);
  }
  // Constant-time is unnecessary here: the challenge is a public random value
  // and a mismatch is simply fatal.
  if (parsed.challenge !== expectedChallenge) {
    throw new Error('Challenge did not match. Try again.');
  }
  if (!expectedOrigins.includes(parsed.origin)) {
    throw new Error(`Unexpected origin ${parsed.origin}.`);
  }
  return parsed;
}

function checkRpIdHash(rpIdHash, rpId) {
  if (!sha256(Buffer.from(rpId, 'utf8')).equals(Buffer.from(rpIdHash))) {
    throw new Error('This credential belongs to a different site.');
  }
}

/* ---------- registration ---------- */

export function registrationOptions({ user, rpId, rpName, excludeCredentialIds = [] }) {
  return {
    challenge: newChallenge(),
    rp: { id: rpId, name: rpName },
    user: { id: b64url(Buffer.from(user.id, 'utf8')), name: user.email || user.name, displayName: user.name },
    pubKeyCredParams: SUPPORTED_ALGS.map((alg) => ({ type: 'public-key', alg })),
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
    excludeCredentials: excludeCredentialIds.map((id) => ({ type: 'public-key', id })),
    timeout: 60000,
    attestation: 'none',
  };
}

/**
 * Verify a registration response and return what should be persisted.
 * Attestation statements are not validated — we use attestation:'none', so the
 * authenticator's identity is not being asserted, only possession of the key.
 */
export function verifyRegistration({
  clientDataJSON, attestationObject, expectedChallenge, expectedOrigins, rpId,
}) {
  checkClientData(clientDataJSON, {
    expectedType: 'webauthn.create', expectedChallenge, expectedOrigins,
  });

  const attestation = decode(fromB64url(attestationObject));
  const authDataRaw = attestation.get('authData');
  if (!Buffer.isBuffer(authDataRaw)) throw new Error('Attestation object is missing authenticator data.');

  const authData = parseAuthData(authDataRaw);
  checkRpIdHash(authData.rpIdHash, rpId);
  if (!authData.userPresent) throw new Error('The authenticator did not confirm user presence.');
  if (!authData.attestedCredentialData) throw new Error('No credential was created.');

  // Parsing proves the key is well formed and of a type we can verify later.
  const { alg } = coseToPublicKey(authData.credentialPublicKey);

  return {
    credentialId: b64url(authData.credentialId),
    publicKey: b64url(Buffer.from(encodeCose(authData.credentialPublicKey))),
    alg,
    signCount: authData.signCount,
    userVerified: authData.userVerified,
  };
}

/* ---------- authentication ---------- */

export function authenticationOptions({ rpId, allowCredentialIds = [] }) {
  return {
    challenge: newChallenge(),
    rpId,
    allowCredentials: allowCredentialIds.map((id) => ({ type: 'public-key', id })),
    userVerification: 'preferred',
    timeout: 60000,
  };
}

export function verifyAuthentication({
  clientDataJSON, authenticatorData, signature, expectedChallenge, expectedOrigins,
  rpId, storedPublicKey, storedSignCount,
}) {
  checkClientData(clientDataJSON, {
    expectedType: 'webauthn.get', expectedChallenge, expectedOrigins,
  });

  const authDataRaw = fromB64url(authenticatorData);
  const authData = parseAuthData(authDataRaw);
  checkRpIdHash(authData.rpIdHash, rpId);
  if (!authData.userPresent) throw new Error('The authenticator did not confirm user presence.');

  const key = coseToPublicKey(decode(fromB64url(storedPublicKey)));
  const signedData = Buffer.concat([authDataRaw, sha256(fromB64url(clientDataJSON))]);
  if (!verifySignature(key, signedData, fromB64url(signature))) {
    throw new Error('Signature verification failed.');
  }

  // A counter that fails to advance can indicate a cloned authenticator. Many
  // real authenticators report 0 permanently, which is explicitly allowed.
  if (storedSignCount > 0 && authData.signCount > 0 && authData.signCount <= storedSignCount) {
    throw new Error('The authenticator signature counter did not advance.');
  }

  return { signCount: authData.signCount, userVerified: authData.userVerified };
}

/* ---------- minimal COSE re-encoding ---------- */

/** Re-encode a decoded COSE key so it can be stored verbatim. */
function encodeCose(map) {
  const chunks = [];
  const head = (major, arg) => {
    if (arg < 24) return Buffer.from([(major << 5) | arg]);
    if (arg < 256) return Buffer.from([(major << 5) | 24, arg]);
    if (arg < 65536) { const b = Buffer.alloc(3); b[0] = (major << 5) | 25; b.writeUInt16BE(arg, 1); return b; }
    const b = Buffer.alloc(5); b[0] = (major << 5) | 26; b.writeUInt32BE(arg, 1); return b;
  };
  const item = (v) => {
    if (typeof v === 'number' && Number.isInteger(v)) {
      return v >= 0 ? head(0, v) : head(1, -1 - v);
    }
    if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
    if (typeof v === 'string') { const b = Buffer.from(v, 'utf8'); return Buffer.concat([head(3, b.length), b]); }
    throw new Error('Cannot re-encode COSE value.');
  };

  chunks.push(head(5, map.size));
  // Canonical COSE ordering: shorter keys first, then numerically ascending.
  const keys = [...map.keys()].sort((a, b) => (a >= 0 ? 0 : 1) - (b >= 0 ? 0 : 1) || Math.abs(a) - Math.abs(b));
  for (const k of keys) {
    chunks.push(item(k));
    chunks.push(item(map.get(k)));
  }
  return Buffer.concat(chunks);
}

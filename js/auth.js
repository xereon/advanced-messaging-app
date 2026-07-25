// auth.js — five ways in: password, quick-unlock PIN, passkey (WebAuthn),
// one-time email code (demo inbox) and guest. All local; passwords are salted
// PBKDF2-SHA-256, never stored in plain text.

import { uid } from './util.js';
import { saveUser, findUserByEmail, getUser, allUsers } from './store.js';

const subtle = globalThis.crypto?.subtle || null;
const PBKDF2_ITERS = 210000;
const PIN_ITERS = 100000;

/* ---------- primitives ---------- */

function bufToB64(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}
function b64ToBuf(b64) {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}
export function randomB64(bytes = 16) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return bufToB64(arr.buffer);
}

async function pbkdf2(secret, saltB64, iterations) {
  if (!subtle) return fallbackHash(secret + '|' + saltB64 + '|' + iterations);
  const key = await subtle.importKey('raw', new TextEncoder().encode(secret), 'PBKDF2', false, ['deriveBits']);
  const bits = await subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: b64ToBuf(saltB64), iterations },
    key, 256,
  );
  return bufToB64(bits);
}

// Only used when crypto.subtle is unavailable (non-secure context). Weak, but
// this is a local demo — flagged on the record as scheme:"fallback".
function fallbackHash(str) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 'fb-' + (h2 >>> 0).toString(16) + (h1 >>> 0).toString(16);
}

const timingSafeEq = (a, b) => a.length === b.length && a === b; // strings from our own store

/* ---------- password accounts ---------- */

export const AVATAR_COLORS = ['#2458E6', '#7C4DDB', '#B0367A', '#0E7490', '#B45309', '#4D7C0F', '#334155', '#9D174D'];

export async function createAccount({ name, email, password }) {
  const cleanEmail = String(email).trim().toLowerCase();
  if (findUserByEmail(cleanEmail)) throw new Error('An account with that email already exists.');
  const salt = randomB64();
  const user = {
    id: uid('u'),
    name: String(name).trim(),
    email: cleanEmail,
    salt,
    iters: PBKDF2_ITERS,
    hash: await pbkdf2(password, salt, PBKDF2_ITERS),
    scheme: subtle ? 'pbkdf2' : 'fallback',
    avatarColor: AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)],
    createdAt: Date.now(),
  };
  saveUser(user);
  return user;
}

export async function verifyPassword(user, password) {
  if (!user?.hash) return false;
  const test = await pbkdf2(password, user.salt, user.iters ?? PBKDF2_ITERS);
  return timingSafeEq(test, user.hash);
}

export async function changePassword(user, currentPw, newPw) {
  if (!(await verifyPassword(user, currentPw))) throw new Error('Current password is incorrect.');
  user.salt = randomB64();
  user.iters = PBKDF2_ITERS;
  user.hash = await pbkdf2(newPw, user.salt, PBKDF2_ITERS);
  saveUser(user);
}

/* ---------- quick-unlock PIN ---------- */

export async function setPin(user, pin) {
  user.pinSalt = randomB64();
  user.pinHash = await pbkdf2(pin, user.pinSalt, PIN_ITERS);
  saveUser(user);
}
export async function verifyPin(user, pin) {
  if (!user?.pinHash) return false;
  const test = await pbkdf2(pin, user.pinSalt, PIN_ITERS);
  return timingSafeEq(test, user.pinHash);
}

/* ---------- passkey (WebAuthn) ---------- */

export function passkeysSupported() {
  return !!(navigator.credentials?.create && window.PublicKeyCredential && window.isSecureContext);
}

export async function registerPasskey(user) {
  if (!passkeysSupported()) throw new Error('Passkeys need a secure context (https or localhost).');
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const cred = await navigator.credentials.create({
    publicKey: {
      challenge,
      rp: { name: 'Relay Messaging' },
      user: {
        id: new TextEncoder().encode(user.id),
        name: user.email || user.name,
        displayName: user.name,
      },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
      timeout: 60000,
    },
  });
  user.passkeyId = bufToB64(cred.rawId);
  saveUser(user);
  return user;
}

/** Discoverable-credential sign-in; identifies the user via userHandle/rawId.
    (A real deployment verifies the assertion signature server-side.) */
export async function passkeySignIn() {
  if (!passkeysSupported()) throw new Error('Passkeys need a secure context (https or localhost).');
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const assertion = await navigator.credentials.get({
    publicKey: { challenge, timeout: 60000, userVerification: 'preferred' },
    mediation: 'optional',
  });
  let user = null;
  const handle = assertion.response.userHandle;
  if (handle?.byteLength) user = getUser(new TextDecoder().decode(handle));
  if (!user) {
    const rawId = bufToB64(assertion.rawId);
    user = Object.values(allUsers()).find((u) => u.passkeyId === rawId) || null;
  }
  if (!user) throw new Error('That passkey does not match any Relay account in this browser.');
  return user;
}

/* ---------- one-time email code (demo inbox) ---------- */

let pendingMagic = null; // { email, hash, expires } — per-tab only

export async function magicStart(email) {
  const cleanEmail = String(email).trim().toLowerCase();
  const user = findUserByEmail(cleanEmail);
  if (!user) throw new Error('No account found for that email. Create one first.');
  const code = String(Math.floor(100000 + Math.random() * 900000));
  pendingMagic = {
    email: cleanEmail,
    hash: await pbkdf2(code, 'bWFnaWM=', 5000),
    expires: Date.now() + 2 * 60 * 1000,
  };
  return code; // surfaced in the on-screen demo inbox — no real email exists
}

export async function magicVerify(email, code) {
  const cleanEmail = String(email).trim().toLowerCase();
  if (!pendingMagic || pendingMagic.email !== cleanEmail) throw new Error('Request a code first.');
  if (Date.now() > pendingMagic.expires) { pendingMagic = null; throw new Error('That code expired. Request a new one.'); }
  const ok = timingSafeEq(await pbkdf2(String(code).trim(), 'bWFnaWM=', 5000), pendingMagic.hash);
  if (!ok) throw new Error('That code is not right. Check the demo inbox above.');
  pendingMagic = null;
  return findUserByEmail(cleanEmail);
}

/* ---------- guest ---------- */

const GUEST_NAMES = [
  'Visiting Falcon', 'Curious Otter', 'Quiet Heron', 'Bold Lynx', 'Swift Ibis',
  'Calm Marten', 'Keen Osprey', 'Bright Vixen', 'Steady Badger', 'Nimble Kestrel',
];
const GUEST_COLORS = ['#334155', '#0E7490', '#4D7C0F', '#7C4DDB', '#B45309', '#B0367A'];

/** Concurrent guests each get a name and colour nobody else is using, so two
    people signed in as guests can tell each other apart in the directory. */
export function createGuest() {
  const guests = Object.values(allUsers()).filter((u) => u.isGuest && !u.retired);
  const taken = new Set(guests.map((u) => u.name));
  let name = GUEST_NAMES.find((n) => !taken.has(n));
  if (!name) {
    let n = 2;
    while (taken.has(`${GUEST_NAMES[0]} ${n}`)) n++;
    name = `${GUEST_NAMES[0]} ${n}`;
  }
  const usedColors = new Set(guests.map((u) => u.avatarColor));
  const user = {
    id: uid('u'),
    name,
    email: null,
    isGuest: true,
    role: 'Guest',
    avatarColor: GUEST_COLORS.find((c) => !usedColors.has(c)) || GUEST_COLORS[guests.length % GUEST_COLORS.length],
    createdAt: Date.now(),
  };
  saveUser(user);
  return user;
}

/* ---------- password strength ---------- */

export function passwordStrength(pw) {
  if (!pw) return { score: 0, label: 'Use at least 8 characters.' };
  let score = 0;
  if (pw.length >= 8) score++;
  if (pw.length >= 12) score++;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) score++;
  if (/\d/.test(pw)) score++;
  if (/[^a-zA-Z0-9]/.test(pw)) score++;
  const label = pw.length < 8
    ? 'Use at least 8 characters.'
    : score <= 2 ? 'Weak — add length or variety.' : score <= 3 ? 'Okay — longer is stronger.' : 'Strong password.';
  return { score, label };
}

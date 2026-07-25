// index.js — HTTP server: static files, JSON API, SSE stream.
// No framework; node:http plus the modules in this folder.

import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as db from './db.js';
import * as auth from './auth.js';
import * as api from './api.js';
import * as rt from './realtime.js';
import * as webauthn from './webauthn.js';
import * as files from './files.js';
import * as mailer from './mailer.js';
import { seedBots, seedConversationsFor, cancelBotTimers } from './bots.js';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PUBLIC_DIR = join(ROOT, 'public');
const PORT = Number(process.env.PORT || 8130);
const DB_FILE = process.env.RELAY_DB || join(ROOT, 'data', 'relay.db');
const UPLOAD_DIR = process.env.RELAY_UPLOADS || join(ROOT, 'data', 'uploads');
const SECURE_COOKIES = process.env.RELAY_SECURE === '1';
const MAX_BODY = 256 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};

/* ---------- small helpers ---------- */

function send(res, status, body, headers = {}) {
  const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
}

const fail = (res, status, message) => send(res, status, { error: message });

function readCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new api.HttpError(413, 'Request too large.')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new api.HttpError(400, 'Invalid JSON body.')); }
    });
    req.on('error', reject);
  });
}

const clientIp = (req) => req.socket.remoteAddress || 'unknown';

/** Enough to recognise your own address, not enough to disclose someone's. */
function maskEmail(email) {
  const [local = '', domain = ''] = String(email).split('@');
  const head = local.slice(0, 2);
  return `${head}${'•'.repeat(Math.max(local.length - 2, 1))}@${domain}`;
}

/** Credential rows as the client should see them — never the public key. */
const publicCredential = (row) => ({
  id: row.credential_id,
  label: row.label,
  createdAt: row.created_at,
  lastUsedAt: row.last_used_at,
});

/**
 * Serve a stored attachment. Only types on the inline allow-list keep their
 * real Content-Type; everything else is forced to a download so nothing a user
 * uploaded can execute in the origin. A restrictive CSP backs that up.
 */
function streamAttachment(req, res, row, forceDownload) {
  const inline = files.isInlineImage(row.mime) && !forceDownload;
  const disposition = inline ? 'inline' : 'attachment';
  const asciiName = row.name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');
  const stream = createReadStream(row.path);
  stream.on('error', () => { if (!res.headersSent) fail(res, 404, 'File is missing.'); else res.destroy(); });
  res.writeHead(200, {
    'Content-Type': inline ? row.mime : 'application/octet-stream',
    'Content-Length': row.size,
    'Content-Disposition': `${disposition}; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(row.name)}`,
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, max-age=31536000, immutable',
  });
  stream.pipe(res);
}

/* ---------- static ---------- */

async function serveStatic(req, res, pathname) {
  const rel = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, '');
  let filePath = join(PUBLIC_DIR, rel);
  if (!filePath.startsWith(PUBLIC_DIR)) return fail(res, 403, 'Forbidden');
  try {
    let info = await stat(filePath);
    if (info.isDirectory()) { filePath = join(filePath, 'index.html'); info = await stat(filePath); }
    const body = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[extname(filePath)] || 'application/octet-stream',
      'Content-Length': body.length,
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(body);
  } catch {
    // Unknown path with no extension: let the single-page app handle routing.
    if (!extname(filePath)) return serveStatic(req, res, '/index.html');
    fail(res, 404, 'Not found');
  }
}

/* ---------- routing ---------- */

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

async function handleApi(req, res, url) {
  const path = url.pathname.replace(/^\/api/, '') || '/';
  const method = req.method;
  const cookies = readCookies(req);
  const session = auth.sessionUser(cookies[auth.SESSION_COOKIE]);
  const me = session?.user || null;

  // CSRF: state-changing calls must carry a header a cross-site form cannot set.
  if (!SAFE.has(method) && req.headers['x-relay-client'] !== '1') {
    return fail(res, 403, 'Missing client header.');
  }

  // File uploads keep their raw stream — reading it as JSON here would consume
  // the body before the upload handler ever sees it.
  const isUpload = method === 'POST' && /^\/conversations\/[^/]+\/attachments$/.test(path);
  const body = SAFE.has(method) || isUpload ? {} : await readBody(req);
  const need = () => { if (!me) throw new api.HttpError(401, 'Sign in first.'); return me; };
  let m;

  const startSession = (user, method_, ttlMs) => {
    const { token, expiresAt } = auth.createSession(user.id, method_, ttlMs ? { ttlMs } : {});
    return { 'Set-Cookie': auth.cookieHeader(token, expiresAt, SECURE_COOKIES) };
  };

  /* --- auth --- */
  if (path === '/auth/signup' && method === 'POST') {
    // Generous enough that a whole office behind one NAT address can sign up,
    // strict enough to stop scripted account farming.
    if (!auth.rateLimit(`signup:${clientIp(req)}`, { limit: 60, windowMs: 60 * 60 * 1000 })) {
      return fail(res, 429, 'Too many sign-ups from this address. Try again later.');
    }
    const { name, email, password } = body;
    if (!String(name || '').trim()) return fail(res, 400, 'Enter your name.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || ''))) return fail(res, 400, 'Enter a valid email address.');
    if (String(password || '').length < 8) return fail(res, 400, 'Password must be at least 8 characters.');
    const user = await auth.createAccount({ name, email, password });
    seedConversationsFor(user.id, user.name);
    return send(res, 201, { user: auth.publicUser(user) }, startSession(user, 'password'));
  }

  if (path === '/auth/login' && method === 'POST') {
    const email = auth.normalizeEmail(body.email);
    const ipKey = `login:${clientIp(req)}`;
    const userKey = `login:user:${email}`;
    if (!auth.rateLimit(ipKey, { limit: 20, windowMs: 15 * 60 * 1000 })
      || !auth.rateLimit(userKey, { limit: 8, windowMs: 15 * 60 * 1000 })) {
      return fail(res, 429, 'Too many attempts. Wait a few minutes and try again.');
    }
    const user = auth.findByEmail(email);
    // Same message and comparable work either way, so the response does not
    // reveal whether the address is registered.
    const ok = user && await auth.verifySecret(body.password, user.pw_salt, user.pw_hash);
    if (!ok) {
      if (!user) await auth.makeSecret(String(body.password || ''));
      return fail(res, 401, 'Email or password is incorrect.');
    }
    seedConversationsFor(user.id, user.name);
    return send(res, 200, { user: auth.publicUser(user) }, startSession(user, 'password'));
  }

  if (path === '/auth/guest' && method === 'POST') {
    if (!auth.rateLimit(`guest:${clientIp(req)}`, { limit: 20, windowMs: 60 * 60 * 1000 })) {
      return fail(res, 429, 'Too many guest sessions from this address.');
    }
    const user = auth.createGuest();
    seedConversationsFor(user.id, user.name);
    return send(res, 201, { user: auth.publicUser(user) }, startSession(user, 'guest', auth.GUEST_TTL_MS));
  }

  if (path === '/auth/code/request' && method === 'POST') {
    if (!auth.rateLimit(`code:${clientIp(req)}`, { limit: 10, windowMs: 15 * 60 * 1000 })) {
      return fail(res, 429, 'Too many code requests. Wait a few minutes.');
    }
    const { code, user } = await auth.issueLoginCode(body.email);
    if (mailer.isConfigured()) {
      try {
        await mailer.send({ to: user.email, ...mailer.loginCodeEmail(user.name, code) });
        // The code is never returned once it has actually been emailed.
        return send(res, 200, { delivery: 'email', to: maskEmail(user.email) });
      } catch (err) {
        console.error('[relay] SMTP delivery failed:', err.message);
        return fail(res, 502, 'Could not send the email. Try again, or use your password.');
      }
    }
    // Without a mail transport the code is shown on screen instead. Set the
    // RELAY_SMTP_* variables to switch to real delivery.
    return send(res, 200, { delivery: 'demo-inbox', code, name: user.name });
  }

  if (path === '/auth/code/verify' && method === 'POST') {
    const user = await auth.redeemLoginCode(body.email, body.code);
    seedConversationsFor(user.id, user.name);
    return send(res, 200, { user: auth.publicUser(user) }, startSession(user, 'code'));
  }

  if (path === '/auth/pin' && method === 'POST') {
    const key = `pin:${clientIp(req)}:${body.userId}`;
    if (!auth.rateLimit(key, { limit: 8, windowMs: 15 * 60 * 1000 })) {
      return fail(res, 429, 'Too many PIN attempts. Use your password instead.');
    }
    const user = auth.findById(String(body.userId || ''));
    const ok = user && await auth.verifySecret(body.pin, user.pin_salt, user.pin_hash);
    if (!ok) return fail(res, 401, 'That PIN is not right.');
    return send(res, 200, { user: auth.publicUser(user) }, startSession(user, 'pin'));
  }

  /* --- passkeys (WebAuthn) --- */

  // The relying-party id is the site's hostname; the browser refuses anything
  // that does not match the page it is on.
  const host = String(req.headers.host || 'localhost');
  const rpId = host.split(':')[0];
  const expectedOrigins = [
    `http://${host}`,
    `https://${host}`,
    ...(process.env.RELAY_ORIGIN ? [process.env.RELAY_ORIGIN] : []),
  ];

  if (path === '/auth/passkey/register/options' && method === 'POST') {
    const user = need();
    const options = webauthn.registrationOptions({
      user: auth.publicUser(user),
      rpId,
      rpName: 'Relay',
      excludeCredentialIds: auth.credentialsOf(user.id).map((c) => c.credential_id),
    });
    auth.storeChallenge(options.challenge, 'register', user.id);
    return send(res, 200, options);
  }

  if (path === '/auth/passkey/register/verify' && method === 'POST') {
    const user = need();
    const pending = auth.takeChallenge(body.challenge, 'register');
    if (!pending || pending.user_id !== user.id) return fail(res, 400, 'That registration expired. Try again.');
    let credential;
    try {
      credential = webauthn.verifyRegistration({
        clientDataJSON: body.clientDataJSON,
        attestationObject: body.attestationObject,
        expectedChallenge: pending.challenge,
        expectedOrigins,
        rpId,
      });
    } catch (err) {
      return fail(res, 400, err.message);
    }
    auth.saveCredential(user.id, credential, body.label);
    return send(res, 201, { credentials: auth.credentialsOf(user.id).map(publicCredential) });
  }

  if (path === '/auth/passkey/login/options' && method === 'POST') {
    if (!auth.rateLimit(`passkey:${clientIp(req)}`, { limit: 30, windowMs: 15 * 60 * 1000 })) {
      return fail(res, 429, 'Too many attempts. Wait a few minutes.');
    }
    // Discoverable credentials: no allow-list, so the browser offers whichever
    // passkey the user has for this site without us naming an account first.
    const options = webauthn.authenticationOptions({ rpId });
    auth.storeChallenge(options.challenge, 'login');
    return send(res, 200, options);
  }

  if (path === '/auth/passkey/login/verify' && method === 'POST') {
    const pending = auth.takeChallenge(body.challenge, 'login');
    if (!pending) return fail(res, 400, 'That sign-in expired. Try again.');
    const stored = auth.findCredential(body.credentialId);
    if (!stored) return fail(res, 401, 'That passkey is not registered here.');
    const user = auth.findById(stored.user_id);
    if (!user) return fail(res, 401, 'That passkey is not registered here.');

    let result;
    try {
      result = webauthn.verifyAuthentication({
        clientDataJSON: body.clientDataJSON,
        authenticatorData: body.authenticatorData,
        signature: body.signature,
        expectedChallenge: pending.challenge,
        expectedOrigins,
        rpId,
        storedPublicKey: stored.public_key,
        storedSignCount: stored.sign_count,
      });
    } catch (err) {
      return fail(res, 401, err.message);
    }
    auth.touchCredential(stored.credential_id, result.signCount);
    seedConversationsFor(user.id, user.name);
    return send(res, 200, { user: auth.publicUser(user) }, startSession(user, 'passkey'));
  }

  if (path === '/account/passkeys' && method === 'GET') {
    return send(res, 200, { credentials: auth.credentialsOf(need().id).map(publicCredential) });
  }
  if ((m = path.match(/^\/account\/passkeys\/([^/]+)$/)) && method === 'DELETE') {
    const user = need();
    auth.deleteCredential(user.id, decodeURIComponent(m[1]));
    return send(res, 200, { credentials: auth.credentialsOf(user.id).map(publicCredential) });
  }

  if (path === '/auth/logout' && method === 'POST') {
    const token = cookies[auth.SESSION_COOKIE];
    if (me?.is_guest) api.releaseGuest(me);
    auth.destroySession(token);
    return send(res, 200, { ok: true }, { 'Set-Cookie': auth.clearCookieHeader() });
  }

  /* --- session-bound --- */
  if (path === '/me' && method === 'GET') {
    if (!me) return fail(res, 401, 'Not signed in.');
    return send(res, 200, { user: auth.publicUser(me), method: session.method });
  }

  if (path === '/bootstrap' && method === 'GET') return send(res, 200, api.bootstrap(need()));
  if (path === '/export' && method === 'GET') return send(res, 200, api.exportData(need()));

  if (path === '/users' && method === 'GET') {
    return send(res, 200, { users: api.searchUsers(need(), url.searchParams.get('q')) });
  }

  if (path === '/conversations' && method === 'POST') {
    return send(res, 201, { conversation: api.createConversation(need(), body) });
  }

  if ((m = path.match(/^\/conversations\/([^/]+)\/messages$/)) && method === 'POST') {
    return send(res, 201, { message: api.sendMessage(need(), decodeURIComponent(m[1]), body) });
  }
  if ((m = path.match(/^\/conversations\/([^/]+)\/messages$/)) && method === 'GET') {
    return send(res, 200, api.history(need(), decodeURIComponent(m[1]), {
      beforeSeq: url.searchParams.get('before'),
      limit: url.searchParams.get('limit'),
    }));
  }

  // Uploads are raw bodies, not multipart: the filename and type ride in
  // headers so the stream can go straight to disk with a hard size cap.
  if ((m = path.match(/^\/conversations\/([^/]+)\/attachments$/)) && method === 'POST') {
    const user = need();
    const convoId = decodeURIComponent(m[1]);
    api.assertConvoMember(convoId, user.id);
    const attachment = await files.store(req, {
      userId: user.id,
      convoId,
      name: decodeURIComponent(String(req.headers['x-relay-filename'] || 'file')),
      declaredMime: String(req.headers['content-type'] || '').split(';')[0],
    });
    return send(res, 201, { attachment });
  }

  if ((m = path.match(/^\/attachments\/([^/]+)$/)) && method === 'GET') {
    if (!me) return fail(res, 401, 'Sign in first.');
    const row = files.find(decodeURIComponent(m[1]));
    if (!row) return fail(res, 404, 'Not found.');
    api.assertConvoMember(row.convo_id, me.id);
    return streamAttachment(req, res, row, url.searchParams.get('download') === '1');
  }

  if ((m = path.match(/^\/conversations\/([^/]+)\/read$/)) && method === 'POST') {
    return send(res, 200, api.markRead(need(), decodeURIComponent(m[1]), body.at, body.private));
  }
  if ((m = path.match(/^\/conversations\/([^/]+)\/meta$/)) && method === 'PATCH') {
    return send(res, 200, api.setMeta(need(), decodeURIComponent(m[1]), body));
  }
  if ((m = path.match(/^\/conversations\/([^/]+)\/typing$/)) && method === 'POST') {
    return send(res, 200, api.typing(need(), decodeURIComponent(m[1])));
  }
  if ((m = path.match(/^\/messages\/([^/]+)$/)) && method === 'PATCH') {
    return send(res, 200, { message: api.editMessage(need(), decodeURIComponent(m[1]), body.text) });
  }
  if ((m = path.match(/^\/messages\/([^/]+)$/)) && method === 'DELETE') {
    return send(res, 200, { message: await api.deleteMessage(need(), decodeURIComponent(m[1])) });
  }
  if ((m = path.match(/^\/messages\/([^/]+)\/reactions$/)) && method === 'POST') {
    return send(res, 200, { message: api.toggleReaction(need(), decodeURIComponent(m[1]), body.emoji) });
  }

  if (path === '/contacts' && method === 'POST') return send(res, 200, api.addContact(need(), body.contactId));
  if ((m = path.match(/^\/contacts\/([^/]+)$/)) && method === 'DELETE') {
    return send(res, 200, api.removeContact(need(), decodeURIComponent(m[1])));
  }

  if (path === '/profile' && method === 'PATCH') return send(res, 200, { user: api.updateProfile(need(), body) });
  if (path === '/settings' && method === 'PUT') return send(res, 200, api.saveSettings(need(), body.settings));
  if (path === '/account/pin' && method === 'POST') return send(res, 200, await api.setPin(need(), body.pin));
  if (path === '/account/password' && method === 'POST') {
    return send(res, 200, await api.changePassword(need(), body.current, body.next),
      { 'Set-Cookie': auth.clearCookieHeader() });
  }
  if (path === '/account' && method === 'DELETE') {
    const user = need();
    api.deleteAccount(user);
    return send(res, 200, { ok: true }, { 'Set-Cookie': auth.clearCookieHeader() });
  }

  if (path === '/events' && method === 'GET') {
    if (!me) return fail(res, 401, 'Sign in first.');
    const since = Number(req.headers['last-event-id'] || url.searchParams.get('since') || 0);
    return rt.subscribe(me.id, res, since);
  }

  return fail(res, 404, 'Unknown endpoint.');
}

/* ---------- server ---------- */

export function createApp() {
  return createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');

    try {
      if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
        return await handleApi(req, res, url);
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return fail(res, 405, 'Method not allowed.');
      return await serveStatic(req, res, url.pathname === '/' ? '/index.html' : url.pathname);
    } catch (err) {
      const status = err.status || 500;
      if (status >= 500) console.error('[relay]', err);
      if (!res.headersSent) fail(res, status, status >= 500 ? 'Something went wrong.' : err.message);
    }
  });
}

export async function start({ port = PORT, dbFile = DB_FILE, uploadDir = UPLOAD_DIR } = {}) {
  db.open(dbFile);
  await files.init(uploadDir);
  seedBots();
  auth.pruneExpiredSessions();
  files.sweepOrphans().catch(() => { /* best effort */ });
  const sweeper = setInterval(() => files.sweepOrphans().catch(() => {}), 60 * 60 * 1000);
  sweeper.unref?.();
  const server = createApp();
  server.listen(port, () => {
    console.log(`Relay server listening on http://localhost:${port}`);
    console.log(`Database: ${dbFile}`);
  });

  const shutdown = () => {
    cancelBotTimers();
    rt.closeAll();
    server.close(() => { db.close(); process.exit(0); });
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  return server;
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  start().catch((err) => { console.error('[relay] failed to start:', err); process.exit(1); });
}

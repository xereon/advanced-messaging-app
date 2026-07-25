// index.js — HTTP server: static files, JSON API, SSE stream.
// No framework; node:http plus the modules in this folder.

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as db from './db.js';
import * as auth from './auth.js';
import * as api from './api.js';
import * as rt from './realtime.js';
import { seedBots, seedConversationsFor, cancelBotTimers } from './bots.js';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PUBLIC_DIR = join(ROOT, 'public');
const PORT = Number(process.env.PORT || 8130);
const DB_FILE = process.env.RELAY_DB || join(ROOT, 'data', 'relay.db');
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

  const body = SAFE.has(method) ? {} : await readBody(req);
  const need = () => { if (!me) throw new api.HttpError(401, 'Sign in first.'); return me; };

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
    // No mail transport is configured, so the code comes back for the on-screen
    // demo inbox. Wiring an SMTP provider here is the one remaining step to
    // make this a production email flow — see README.
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

  let m;
  if ((m = path.match(/^\/conversations\/([^/]+)\/messages$/)) && method === 'POST') {
    return send(res, 201, { message: api.sendMessage(need(), decodeURIComponent(m[1]), body) });
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
    return send(res, 200, { message: api.deleteMessage(need(), decodeURIComponent(m[1])) });
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

export function start({ port = PORT, dbFile = DB_FILE } = {}) {
  db.open(dbFile);
  seedBots();
  auth.pruneExpiredSessions();
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

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) start();

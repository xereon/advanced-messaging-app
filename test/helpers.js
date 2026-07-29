// helpers.js — spin up a real server on an ephemeral port with a throwaway
// database, and drive it over HTTP the way a client would.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as db from '../server/db.js';
import * as auth from '../server/auth.js';
import * as rt from '../server/realtime.js';
import { createApp } from '../server/index.js';
import * as files from '../server/files.js';
import { seedBots, cancelBotTimers } from '../server/bots.js';

export async function startTestServer() {
  const dir = mkdtempSync(join(tmpdir(), 'relay-test-'));
  const file = join(dir, 'test.db');
  db.open(file);
  await files.init(join(dir, 'uploads'));
  seedBots();
  auth.resetRateLimits();
  // Limits are exercised deliberately in their own test; elsewhere they would
  // just throttle the suite against itself from a single loopback address.
  auth.setRateLimitEnabled(false);

  const server = createApp();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  return {
    base,
    async stop() {
      cancelBotTimers();
      rt.closeAll();
      await new Promise((resolve) => server.close(resolve));
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** A client bound to one session cookie, like a signed-in browser. */
export function client(base) {
  let cookie = null;
  const call = async (method, path, body, { csrf = true } = {}) => {
    const headers = {};
    if (csrf) headers['X-Relay-Client'] = '1';
    if (cookie) headers.Cookie = cookie;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(base + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = res.headers.getSetCookie?.() || [];
    for (const c of setCookie) {
      const [pair] = c.split(';');
      cookie = pair.startsWith('relay_session=;') ? null : pair;
      if (/relay_session=;/.test(c)) cookie = null;
    }
    const text = await res.text();
    return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : {} };
  };
  return {
    get: (p, o) => call('GET', p, undefined, o),
    post: (p, b, o) => call('POST', p, b ?? {}, o),
    patch: (p, b, o) => call('PATCH', p, b ?? {}, o),
    put: (p, b, o) => call('PUT', p, b ?? {}, o),
    // DELETE carries a body for endpoints keyed by an opaque value (a push
    // endpoint URL), which does not belong in a path segment.
    del: (p, b, o) => call('DELETE', p, b, o),
    get cookie() { return cookie; },
    set cookie(v) { cookie = v; },
  };
}

export async function signUp(base, name, email, password = 'hunter2hunter') {
  const c = client(base);
  const res = await c.post('/api/auth/signup', { name, email, password });
  if (res.status !== 201) throw new Error(`signup failed: ${JSON.stringify(res.body)}`);
  return { client: c, user: res.body.user };
}

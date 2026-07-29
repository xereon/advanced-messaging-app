// sw.js — service worker.
//
// Two jobs, and deliberately no more:
//   1. Keep the app shell available so Relay opens without a network.
//   2. Never cache the API. Messages and sessions must always be live; a stale
//      /api/bootstrap would show yesterday's conversations as if they were now.
//
// Bump CACHE when the shell changes; old caches are dropped on activate.

const CACHE = 'relay-shell-v8';

const SHELL = [
  '/',
  '/index.html',
  '/css/app.css',
  '/js/app.js',
  '/js/api.js',
  '/js/store.js',
  '/js/ui.js',
  '/js/settings.js',
  '/js/palette.js',
  '/js/util.js',
  '/manifest.webmanifest',
  '/icon.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      // A single missing file must not fail the whole install.
      .then((cache) => Promise.allSettled(SHELL.map((url) => cache.add(url))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') self.skipWaiting();
});

/** The files that make up the running app, as opposed to its decoration. */
const isCode = (pathname) => /\.(js|css|html)$/.test(pathname);

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // The API and the live stream are never cached, and never served stale.
  if (url.pathname.startsWith('/api/')) return;

  // The moderation dashboard is invisible to this worker. Two reasons: the
  // navigation branch below stores every page it fetches as the app shell, so
  // an administrator visiting /admin would replace the shell for themselves;
  // and a report queue must not be left in a disk cache on a shared machine.
  if (url.pathname === '/admin' || url.pathname.startsWith('/admin/')) return;

  // Navigations: network first so a deployed change is picked up, falling back
  // to the cached shell when there is no network at all.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put('/index.html', copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match('/index.html').then((hit) => hit || offlineResponse())),
    );
    return;
  }

  // Code is network first, like navigations.
  //
  // Cache-first was serving the previous deploy's script for one load and
  // refreshing behind it, so a fix could look like it had not shipped — and
  // worse, a freshly loaded index.html could pair with a stale module. These
  // files are small and the request is on an already-warm connection, so the
  // cost is negligible; the cache still answers when there is no network.
  if (isCode(url.pathname)) {
    event.respondWith(
      fetch(request)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(request, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => caches.match(request).then((hit) => hit || Response.error())),
    );
    return;
  }

  // Everything else — icons, the manifest — is cache first with a background
  // refresh. Being one version behind on an icon costs nothing.
  event.respondWith(
    caches.match(request).then((hit) => {
      const network = fetch(request)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(request, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => hit);
      return hit || network;
    }),
  );
});


function offlineResponse() {
  return new Response(
    '<!doctype html><meta charset="utf-8"><title>Relay is offline</title>'
    + '<body style="font-family:system-ui;margin:4rem auto;max-width:28rem;padding:0 1.5rem">'
    + '<h1>You are offline</h1><p>Relay could not reach the server and has no cached copy yet. '
    + 'Reconnect and reload.</p>',
    { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
  );
}

/* ---------- push notifications ---------- */

self.addEventListener('push', (event) => {
  if (!event.data) return;
  let payload = {};
  try { payload = event.data.json(); } catch { payload = { title: 'Relay', body: event.data.text() }; }

  const title = payload.title || 'Relay';
  const options = {
    body: payload.body || '',
    icon: '/icon.svg',
    badge: '/icon-maskable.svg',
    // Collapse repeat notifications from one conversation into a single entry.
    tag: payload.convoId || 'relay',
    renotify: true,
    data: { convoId: payload.convoId || null },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const convoId = event.notification.data?.convoId;
  const target = convoId ? `/?convo=${encodeURIComponent(convoId)}` : '/';

  event.waitUntil((async () => {
    const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    // Prefer focusing a tab that is already open over launching another.
    for (const client of clientList) {
      if (new URL(client.url).origin !== self.location.origin) continue;
      await client.focus();
      if (convoId && 'postMessage' in client) client.postMessage({ type: 'open-conversation', convoId });
      return;
    }
    await self.clients.openWindow(target);
  })());
});

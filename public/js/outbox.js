// outbox.js — messages that could not be sent yet.
//
// Without this, pressing Enter with no network loses what you typed: the
// request fails and the bubble is marked failed. The outbox keeps it, survives
// a reload, and flushes when the connection returns.
//
// It lives in localStorage rather than the server, because by definition the
// server is the thing we cannot reach.

const KEY = 'relay:outbox';
const MAX_ATTEMPTS = 8;

function load() {
  try { return JSON.parse(localStorage.getItem(KEY)) || []; } catch { return []; }
}

function save(items) {
  try { localStorage.setItem(KEY, JSON.stringify(items)); } catch { /* private mode or full */ }
}

export function pending(userId) {
  return load().filter((i) => i.userId === userId);
}

export function count(userId) { return pending(userId).length; }

export function add(entry) {
  const items = load();
  items.push({ ...entry, queuedAt: Date.now(), attempts: 0 });
  save(items);
}

export function remove(clientId) {
  save(load().filter((i) => i.clientId !== clientId));
}

/** Give up on an entry, but tell the caller so the UI can say why. */
function exhaust(clientId) {
  const items = load();
  const entry = items.find((i) => i.clientId === clientId);
  save(items.filter((i) => i.clientId !== clientId));
  return entry;
}

function bumpAttempt(clientId) {
  const items = load();
  const entry = items.find((i) => i.clientId === clientId);
  if (entry) { entry.attempts += 1; save(items); }
  return entry?.attempts ?? MAX_ATTEMPTS;
}

/**
 * Try to send everything queued for this user, oldest first.
 *
 * `send` resolves on success and rejects otherwise. A rejection carrying a
 * 4xx status is permanent — the server refused the message, and retrying will
 * not change its mind — so it is dropped rather than retried forever. The
 * exception is 429: see the catch below.
 */
export async function flush(userId, send, { onSent, onGivenUp, onThrottled } = {}) {
  const queued = pending(userId);
  let sent = 0;

  for (const entry of queued) {
    try {
      const message = await send(entry);
      remove(entry.clientId);
      sent += 1;
      onSent?.(entry, message);
    } catch (err) {
      // Being over the rate limit is the one 4xx that stops being true on its
      // own, so it stays queued. It still spends an attempt, because a server
      // that refuses forever must not mean a client that retries forever. The
      // budget it exceeded is shared by everything behind it, so the rest of
      // the queue would be refused too — stop and let the caller retry later.
      if (err?.status === 429) {
        if (bumpAttempt(entry.clientId) >= MAX_ATTEMPTS) {
          onGivenUp?.(exhaust(entry.clientId), err);
          continue;
        }
        onThrottled?.(err);
        break;
      }
      const permanent = err?.status >= 400 && err.status < 500;
      const attempts = permanent ? MAX_ATTEMPTS : bumpAttempt(entry.clientId);
      if (permanent || attempts >= MAX_ATTEMPTS) {
        onGivenUp?.(exhaust(entry.clientId), err);
        continue;
      }
      // A network failure means the rest will fail too; stop and wait.
      break;
    }
  }
  return sent;
}

export function clear(userId) {
  save(load().filter((i) => i.userId !== userId));
}

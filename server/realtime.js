// realtime.js — server→client push over Server-Sent Events.
//
// One SSE stream per open tab, keyed by user. EventSource reconnects on its
// own and replays what it missed via Last-Event-ID, so a dropped connection
// costs nothing.
//
// Presence is deliberately NOT just "who holds a stream in this process".
// Under Passenger (cPanel) or any multi-worker setup, each process has its own
// memory: one worker holds Alice's stream while another answers Bob's request
// and has never heard of her, so she looks offline. Presence therefore lives in
// the database — a heartbeat on users.last_seen — which every worker can read.
// The in-process set is kept as a fast path for the worker that owns the stream.

import { handle } from './db.js';
import { seal, open as unseal } from './crypt.js';

/** userId -> Set<res> */
const streams = new Map();
const HEARTBEAT_MS = 25_000;
/** How often each worker tails the shared event table. */
const BUS_POLL_MS = 250;
/** How long events are retained for a reconnecting client to replay. */
const BUS_RETENTION_MS = 15 * 60 * 1000;
/** How long after its last heartbeat an account still counts as online. */
export const PRESENCE_TTL_MS = 70_000;

/** Highest event id this worker has delivered from the bus. */
let cursor = 0;
/**
 * Events this worker published and already delivered locally. The tail must
 * advance past them without delivering twice.
 */
const selfPublished = new Set();
let busTimer = null;
let pruneCounter = 0;

/* ---------- the shared bus ---------- */

/**
 * Append an event for the other workers to pick up.
 *
 * The payload is sealed like any other stored text. It has to be: a 'message'
 * event carries the message body, so encrypting `messages.text` while writing
 * the same words here as plain JSON would leave them in the file anyway — which
 * is exactly what a grep of the database turned up.
 */
function insertEvent(type, data, audience) {
  const info = handle().prepare(
    'INSERT INTO events (type, data, audience, at) VALUES (?,?,?,?)',
  ).run(type, seal(JSON.stringify(data)), JSON.stringify(audience), Date.now());
  return Number(info.lastInsertRowid);
}

/** Read a stored event payload, sealed or not. */
const eventData = (row) => JSON.parse(unseal(row.data));

function deliverLocal(evt) {
  for (const userId of evt.audience) {
    for (const res of streams.get(userId) || []) writeEvent(res, evt);
  }
}

/** Deliver anything appended by another worker since we last looked. */
function drainBus() {
  let rows;
  try {
    rows = handle().prepare('SELECT * FROM events WHERE id > ? ORDER BY id LIMIT 500').all(cursor);
  } catch {
    return;   // database closing
  }

  for (const row of rows) {
    cursor = row.id;
    // Already delivered by this worker at publish time.
    if (selfPublished.delete(row.id)) continue;
    try {
      deliverLocal({
        id: row.id,
        type: row.type,
        data: eventData(row),
        audience: new Set(JSON.parse(row.audience)),
      });
    } catch { /* a malformed row must not stall the tail */ }
  }

  // Occasionally drop events nobody can still ask to replay.
  if (++pruneCounter % 60 === 0) {
    try {
      handle().prepare('DELETE FROM events WHERE at < ?').run(Date.now() - BUS_RETENTION_MS);
    } catch { /* not important enough to care */ }
  }
}

function startBus() {
  if (busTimer) return;
  // Start from the present, or a first connection would replay the backlog.
  if (cursor === 0) {
    try {
      cursor = handle().prepare('SELECT IFNULL(MAX(id), 0) AS id FROM events').get().id;
    } catch { cursor = 0; }
  }
  busTimer = setInterval(drainBus, BUS_POLL_MS);
  busTimer.unref?.();
}

function stopBusIfIdle() {
  if (streams.size === 0 && busTimer) {
    clearInterval(busTimer);
    busTimer = null;
  }
}

/** Exposed for tests: drain synchronously instead of waiting for the timer. */
export function pumpBus() { drainBus(); }

export function subscribe(userId, res, sinceId) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');

  if (!streams.has(userId)) streams.set(userId, new Set());
  const wasOffline = streams.get(userId).size === 0;
  streams.get(userId).add(res);

  startBus();

  // Replay anything this user missed while disconnected. Reading from the
  // shared table means a resume works even if the reconnect lands on a
  // different worker than the original connection.
  if (sinceId > 0) {
    try {
      const rows = handle().prepare(
        'SELECT * FROM events WHERE id > ? ORDER BY id LIMIT 500',
      ).all(sinceId);
      for (const row of rows) {
        const audience = JSON.parse(row.audience);
        if (!audience.includes(userId)) continue;
        writeEvent(res, { id: row.id, type: row.type, data: eventData(row) });
      }
    } catch { /* replay is best effort */ }
  }

  // The heartbeat does double duty: it keeps the connection from idling out,
  // and it refreshes this account's presence for every other worker to see.
  touchLastSeen(userId);
  const heartbeat = setInterval(() => {
    try { res.write(': ping\n\n'); } catch { /* closed */ }
    touchLastSeen(userId);
  }, HEARTBEAT_MS);
  heartbeat.unref?.();

  const cleanup = () => {
    clearInterval(heartbeat);
    const set = streams.get(userId);
    if (!set) return;
    set.delete(res);
    if (set.size === 0) {
      streams.delete(userId);
      // Backdate the heartbeat so other workers stop counting them as online
      // rather than waiting out the full TTL.
      expireLastSeen(userId);
      publishPresence(userId, false);
      stopBusIfIdle();
    }
  };
  res.on('close', cleanup);
  res.on('error', cleanup);

  if (wasOffline) publishPresence(userId, true);
}

function touchLastSeen(userId) {
  try {
    handle().prepare('UPDATE users SET last_seen = ? WHERE id = ?').run(Date.now(), userId);
  } catch { /* db may be closing */ }
}

function expireLastSeen(userId) {
  try {
    handle().prepare('UPDATE users SET last_seen = ? WHERE id = ?')
      .run(Date.now() - PRESENCE_TTL_MS - 1000, userId);
  } catch { /* db may be closing */ }
}

function writeEvent(res, evt) {
  try {
    res.write(`id: ${evt.id}\nevent: ${evt.type}\ndata: ${JSON.stringify(evt.data)}\n\n`);
  } catch { /* closed mid-write; cleanup handles removal */ }
}

/**
 * Push an event to a specific set of users, wherever they are connected.
 *
 * The event is appended to the shared table so every worker can see it, then
 * delivered immediately to any stream this worker holds — so a client on this
 * worker sees no added latency, and clients elsewhere arrive one poll later.
 */
export function publish(userIds, type, data) {
  const audience = [...new Set(userIds)];
  if (!audience.length) return;

  let id;
  try {
    id = insertEvent(type, data, audience);
  } catch {
    // If the append fails, still serve the clients we can reach directly.
    deliverLocal({ id: 0, type, data, audience: new Set(audience) });
    return;
  }
  selfPublished.add(id);
  deliverLocal({ id, type, data, audience: new Set(audience) });
}

/** Everyone who shares a conversation with this user, plus the user. */
export function contactAudience(userId) {
  // Presence must not flow between people who have blocked each other.
  const blocked = new Set(handle().prepare(
    `SELECT blocked_id AS id FROM blocks WHERE user_id = ?
     UNION SELECT user_id AS id FROM blocks WHERE blocked_id = ?`,
  ).all(userId, userId).map((r) => r.id));
  const rows = handle().prepare(
    `SELECT DISTINCT m2.user_id AS id FROM members m1
       JOIN members m2 ON m2.convo_id = m1.convo_id
      WHERE m1.user_id = ?
     UNION SELECT user_id AS id FROM contacts WHERE contact_id = ?`,
  ).all(userId, userId);
  return [...new Set([userId, ...rows.map((r) => r.id)])].filter((id) => id === userId || !blocked.has(id));
}

export function convoAudience(convoId) {
  return handle().prepare('SELECT user_id FROM members WHERE convo_id = ?')
    .all(convoId).map((r) => r.user_id);
}

function publishPresence(userId, online) {
  publish(contactAudience(userId), 'presence', { userId, online, at: Date.now() });
}

/**
 * Everyone currently online, according to the database rather than this
 * worker's memory. Bots are always available.
 */
export function onlineUserIds() {
  const cutoff = Date.now() - PRESENCE_TTL_MS;
  try {
    const rows = handle().prepare(
      'SELECT id FROM users WHERE is_bot = 1 OR last_seen > ?',
    ).all(cutoff);
    // Union with this worker's own streams: a client that has just connected
    // may not have written its first heartbeat yet.
    return [...new Set([...rows.map((r) => r.id), ...streams.keys()])];
  } catch {
    return [...streams.keys()];
  }
}

export function isOnline(userId) {
  if (streams.has(userId)) return true;
  try {
    const row = handle().prepare('SELECT is_bot, last_seen FROM users WHERE id = ?').get(userId);
    if (!row) return false;
    return !!row.is_bot || row.last_seen > Date.now() - PRESENCE_TTL_MS;
  } catch {
    return false;
  }
}

export function closeAll() {
  if (busTimer) { clearInterval(busTimer); busTimer = null; }
  for (const set of streams.values()) {
    for (const res of set) { try { res.end(); } catch { /* already gone */ } }
  }
  streams.clear();
}

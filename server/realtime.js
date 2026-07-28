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

/** userId -> Set<res> */
const streams = new Map();
/** Recent events kept in memory so a reconnecting client can catch up. */
const backlog = [];
const BACKLOG_LIMIT = 500;
const HEARTBEAT_MS = 25_000;
/** How long after its last heartbeat an account still counts as online. */
export const PRESENCE_TTL_MS = 70_000;

let lastEventId = 0;

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

  // Replay anything this user missed while disconnected.
  if (sinceId > 0) {
    for (const evt of backlog) {
      if (evt.id > sinceId && evt.audience.has(userId)) writeEvent(res, evt);
    }
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

/** Push an event to a specific set of users. */
export function publish(userIds, type, data) {
  const audience = new Set(userIds);
  if (!audience.size) return;
  const evt = { id: ++lastEventId, type, data, audience };
  backlog.push(evt);
  if (backlog.length > BACKLOG_LIMIT) backlog.shift();
  for (const userId of audience) {
    for (const res of streams.get(userId) || []) writeEvent(res, evt);
  }
}

/** Everyone who shares a conversation with this user, plus the user. */
export function contactAudience(userId) {
  const rows = handle().prepare(
    `SELECT DISTINCT m2.user_id AS id FROM members m1
       JOIN members m2 ON m2.convo_id = m1.convo_id
      WHERE m1.user_id = ?
     UNION SELECT user_id AS id FROM contacts WHERE contact_id = ?`,
  ).all(userId, userId);
  return [...new Set([userId, ...rows.map((r) => r.id)])];
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
  for (const set of streams.values()) {
    for (const res of set) { try { res.end(); } catch { /* already gone */ } }
  }
  streams.clear();
}

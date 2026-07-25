// api.js — REST handlers. Every route that touches a conversation proves the
// caller is a member of it first; nothing trusts an id from the client.

import { handle, tx, nextSeq, currentSeq, publicUser, shapeMessage, shapeConvo } from './db.js';
import * as auth from './auth.js';
import * as rt from './realtime.js';
import { scheduleBotReply } from './bots.js';

const MAX_TEXT = 4000;
const HISTORY_LIMIT = 200;

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (msg) => { throw new HttpError(400, msg); };

/* ---------- helpers ---------- */

function assertMember(convoId, userId) {
  const row = handle().prepare('SELECT 1 AS ok FROM members WHERE convo_id = ? AND user_id = ?')
    .get(convoId, userId);
  if (!row) throw new HttpError(403, 'You are not a member of that conversation.');
}

function ownMessage(msgId, userId) {
  const row = handle().prepare('SELECT * FROM messages WHERE id = ?').get(msgId);
  if (!row) throw new HttpError(404, 'Message not found.');
  assertMember(row.convo_id, userId);
  if (row.from_id !== userId) throw new HttpError(403, 'You can only change your own messages.');
  return row;
}

function reactionsFor(msgIds) {
  if (!msgIds.length) return {};
  const marks = msgIds.map(() => '?').join(',');
  const rows = handle().prepare(
    `SELECT msg_id, emoji, user_id FROM reactions WHERE msg_id IN (${marks})`,
  ).all(...msgIds);
  const out = {};
  for (const r of rows) {
    out[r.msg_id] ??= {};
    (out[r.msg_id][r.emoji] ??= []).push(r.user_id);
  }
  return out;
}

function loadMessages(convoId, limit = HISTORY_LIMIT) {
  const rows = handle().prepare(
    'SELECT * FROM messages WHERE convo_id = ? ORDER BY at DESC, seq DESC LIMIT ?',
  ).all(convoId, limit).reverse();
  const reactions = reactionsFor(rows.map((r) => r.id));
  return rows.map((r) => shapeMessage(r, reactions[r.id] || {}));
}

function convoWithMembers(row) {
  const members = handle().prepare('SELECT user_id FROM members WHERE convo_id = ?')
    .all(row.id).map((m) => m.user_id);
  return shapeConvo(row, members);
}

export function dmId(a, b) { return 'dm:' + [a, b].sort().join('~'); }

function ensureDm(a, b) {
  const db = handle();
  const id = dmId(a, b);
  const existing = db.prepare('SELECT * FROM conversations WHERE id = ?').get(id);
  if (existing) return existing;
  tx(() => {
    db.prepare('INSERT INTO conversations (id, type, title, created_at, created_by) VALUES (?,?,NULL,?,?)')
      .run(id, 'dm', Date.now(), a);
    const ins = db.prepare('INSERT OR IGNORE INTO members (convo_id, user_id) VALUES (?,?)');
    ins.run(id, a);
    ins.run(id, b);
  });
  return db.prepare('SELECT * FROM conversations WHERE id = ?').get(id);
}
export { ensureDm };

/* ---------- bootstrap ---------- */

export function bootstrap(me) {
  const db = handle();
  const convoRows = db.prepare(
    `SELECT c.* FROM conversations c JOIN members m ON m.convo_id = c.id WHERE m.user_id = ?`,
  ).all(me.id);

  const conversations = [];
  const messages = {};
  const reads = {};
  const meta = {};

  for (const row of convoRows) {
    conversations.push(convoWithMembers(row));
    messages[row.id] = loadMessages(row.id);
    reads[row.id] = Object.fromEntries(
      db.prepare('SELECT user_id, at FROM reads WHERE convo_id = ? AND (private = 0 OR user_id = ?)')
        .all(row.id, me.id).map((r) => [r.user_id, r.at]),
    );
    const m = db.prepare('SELECT * FROM convo_meta WHERE user_id = ? AND convo_id = ?').get(me.id, row.id);
    meta[row.id] = {
      pinned: !!m?.pinned, muted: !!m?.muted,
      draft: m?.draft || '', clearedBefore: m?.cleared_before || 0,
    };
  }

  // Everyone the client may need to render: conversation partners, contacts,
  // bots, and any guest currently signed in.
  const peopleRows = db.prepare(`
    SELECT DISTINCT u.* FROM users u WHERE u.id IN (
      SELECT m2.user_id FROM members m1 JOIN members m2 ON m2.convo_id = m1.convo_id WHERE m1.user_id = ?
      UNION SELECT contact_id FROM contacts WHERE user_id = ?
      UNION SELECT id FROM users WHERE is_bot = 1
      UNION SELECT id FROM users WHERE is_guest = 1 AND retired = 0
    ) OR u.id = ?`).all(me.id, me.id, me.id);

  const settingsRow = db.prepare('SELECT json FROM settings WHERE user_id = ?').get(me.id);

  return {
    me: publicUser(me),
    users: peopleRows.map(publicUser),
    conversations,
    messages,
    reads,
    meta,
    contacts: db.prepare('SELECT contact_id FROM contacts WHERE user_id = ?').all(me.id).map((r) => r.contact_id),
    settings: settingsRow ? JSON.parse(settingsRow.json) : null,
    online: rt.onlineUserIds(),
    seq: currentSeq(),
  };
}

/* ---------- people ---------- */

export function searchUsers(me, q) {
  const needle = `%${String(q || '').trim().toLowerCase()}%`;
  const rows = handle().prepare(`
    SELECT * FROM users
     WHERE id != ? AND retired = 0
       AND (LOWER(name) LIKE ? OR LOWER(IFNULL(email,'')) LIKE ? OR LOWER(IFNULL(role,'')) LIKE ?)
     ORDER BY name LIMIT 50`).all(me.id, needle, needle, needle);
  return rows.map(publicUser);
}

/* ---------- conversations ---------- */

export function createConversation(me, { type, title, members }) {
  const db = handle();
  const ids = [...new Set([me.id, ...(Array.isArray(members) ? members : [])])];
  if (ids.length < 2) bad('A conversation needs at least one other person.');
  for (const id of ids) {
    if (!auth.findById(id)) bad('Unknown participant.');
  }

  const announce = (convo) => {
    // Both sides need to learn the conversation exists, or the other client
    // will drop messages for a conversation it has never heard of.
    rt.publish(convo.members, 'conversation', {
      conversation: convo,
      users: convo.members.map((u) => publicUser(auth.findById(u))),
    });
    return convo;
  };

  if (type === 'dm') {
    if (ids.length !== 2) bad('A direct message must have exactly two people.');
    const existing = handle().prepare('SELECT 1 AS ok FROM conversations WHERE id = ?').get(dmId(ids[0], ids[1]));
    const convo = convoWithMembers(ensureDm(ids[0], ids[1]));
    return existing ? convo : announce(convo);
  }

  const clean = String(title || '').trim().slice(0, 50);
  if (!clean) bad('Give the group a name.');
  const id = auth.uid('g');
  tx(() => {
    db.prepare('INSERT INTO conversations (id, type, title, created_at, created_by) VALUES (?,?,?,?,?)')
      .run(id, 'group', clean, Date.now(), me.id);
    const ins = db.prepare('INSERT OR IGNORE INTO members (convo_id, user_id) VALUES (?,?)');
    for (const uid of ids) ins.run(id, uid);
  });
  return announce(convoWithMembers(db.prepare('SELECT * FROM conversations WHERE id = ?').get(id)));
}

/* ---------- messages ---------- */

export function sendMessage(me, convoId, { text, replyTo, clientId }) {
  assertMember(convoId, me.id);
  const clean = String(text ?? '').trim();
  if (!clean) bad('Message is empty.');
  if (clean.length > MAX_TEXT) bad(`Messages are limited to ${MAX_TEXT} characters.`);
  if (replyTo) {
    const orig = handle().prepare('SELECT convo_id FROM messages WHERE id = ?').get(replyTo);
    if (!orig || orig.convo_id !== convoId) bad('You can only reply to a message in this conversation.');
  }

  const now = Date.now();
  const id = auth.uid('m');
  const row = tx(() => {
    const seq = nextSeq();
    handle().prepare(
      `INSERT INTO messages (id, convo_id, from_id, text, at, seq, reply_to, delivered_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    ).run(id, convoId, me.id, clean, now, seq, replyTo || null, now);
    handle().prepare(
      `INSERT INTO reads (convo_id, user_id, at) VALUES (?,?,?)
       ON CONFLICT(convo_id, user_id) DO UPDATE SET at = excluded.at`,
    ).run(convoId, me.id, now);
    return handle().prepare('SELECT * FROM messages WHERE id = ?').get(id);
  });

  const msg = shapeMessage(row);
  rt.publish(rt.convoAudience(convoId), 'message', { message: msg, clientId });
  scheduleBotReply(convoId, msg);
  return msg;
}

export function editMessage(me, msgId, text) {
  const row = ownMessage(msgId, me.id);
  if (row.deleted_at) bad('That message was deleted.');
  const clean = String(text ?? '').trim();
  if (!clean) bad('Message is empty.');
  if (clean.length > MAX_TEXT) bad(`Messages are limited to ${MAX_TEXT} characters.`);
  handle().prepare('UPDATE messages SET text = ?, edited_at = ? WHERE id = ?').run(clean, Date.now(), msgId);
  const msg = shapeMessage(handle().prepare('SELECT * FROM messages WHERE id = ?').get(msgId));
  rt.publish(rt.convoAudience(row.convo_id), 'message-updated', { message: msg });
  return msg;
}

export function deleteMessage(me, msgId) {
  const row = ownMessage(msgId, me.id);
  handle().prepare('UPDATE messages SET deleted_at = ?, text = ? WHERE id = ?').run(Date.now(), '', msgId);
  const msg = shapeMessage(handle().prepare('SELECT * FROM messages WHERE id = ?').get(msgId));
  rt.publish(rt.convoAudience(row.convo_id), 'message-updated', { message: msg });
  return msg;
}

export function toggleReaction(me, msgId, emoji) {
  const db = handle();
  const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(msgId);
  if (!row) throw new HttpError(404, 'Message not found.');
  assertMember(row.convo_id, me.id);
  const clean = String(emoji || '').slice(0, 8);
  if (!clean) bad('Pick an emoji.');

  const existing = db.prepare('SELECT 1 AS ok FROM reactions WHERE msg_id = ? AND user_id = ? AND emoji = ?')
    .get(msgId, me.id, clean);
  if (existing) {
    db.prepare('DELETE FROM reactions WHERE msg_id = ? AND user_id = ? AND emoji = ?').run(msgId, me.id, clean);
  } else {
    db.prepare('INSERT INTO reactions (msg_id, user_id, emoji) VALUES (?,?,?)').run(msgId, me.id, clean);
  }
  const msg = shapeMessage(row, reactionsFor([msgId])[msgId] || {});
  rt.publish(rt.convoAudience(row.convo_id), 'message-updated', { message: msg });
  return msg;
}

/* ---------- reads, meta, typing ---------- */

export function markRead(me, convoId, at, isPrivate = false) {
  assertMember(convoId, me.id);
  const stamp = Number(at) || Date.now();
  const priv = isPrivate ? 1 : 0;
  handle().prepare(
    `INSERT INTO reads (convo_id, user_id, at, private) VALUES (?,?,?,?)
     ON CONFLICT(convo_id, user_id) DO UPDATE SET at = MAX(at, excluded.at), private = excluded.private`,
  ).run(convoId, me.id, stamp, priv);
  // With receipts off the read still counts for this user's own badge, but
  // nobody else is told about it.
  const audience = priv ? [me.id] : rt.convoAudience(convoId);
  rt.publish(audience, 'read', { convoId, userId: me.id, at: stamp });
  return { ok: true };
}

export function setMeta(me, convoId, patch) {
  assertMember(convoId, me.id);
  const db = handle();
  const cur = db.prepare('SELECT * FROM convo_meta WHERE user_id = ? AND convo_id = ?').get(me.id, convoId);
  const next = {
    pinned: patch.pinned ?? !!cur?.pinned,
    muted: patch.muted ?? !!cur?.muted,
    draft: patch.draft ?? cur?.draft ?? '',
    clearedBefore: patch.clearedBefore ?? cur?.cleared_before ?? 0,
  };
  db.prepare(
    `INSERT INTO convo_meta (user_id, convo_id, pinned, muted, draft, cleared_before) VALUES (?,?,?,?,?,?)
     ON CONFLICT(user_id, convo_id) DO UPDATE SET pinned = excluded.pinned, muted = excluded.muted,
       draft = excluded.draft, cleared_before = excluded.cleared_before`,
  ).run(me.id, convoId, next.pinned ? 1 : 0, next.muted ? 1 : 0, String(next.draft).slice(0, MAX_TEXT), next.clearedBefore);
  return next;
}

export function typing(me, convoId) {
  assertMember(convoId, me.id);
  const others = rt.convoAudience(convoId).filter((u) => u !== me.id);
  rt.publish(others, 'typing', { convoId, userId: me.id, name: me.name.split(' ')[0] });
  return { ok: true };
}

/* ---------- contacts ---------- */

export function addContact(me, contactId) {
  if (contactId === me.id) bad('You cannot add yourself.');
  if (!auth.findById(contactId)) throw new HttpError(404, 'No such person.');
  handle().prepare('INSERT OR IGNORE INTO contacts (user_id, contact_id) VALUES (?,?)').run(me.id, contactId);
  rt.publish([me.id], 'contacts', { contacts: listContacts(me) });
  return { ok: true };
}

export function removeContact(me, contactId) {
  handle().prepare('DELETE FROM contacts WHERE user_id = ? AND contact_id = ?').run(me.id, contactId);
  rt.publish([me.id], 'contacts', { contacts: listContacts(me) });
  return { ok: true };
}

export function listContacts(me) {
  return handle().prepare('SELECT contact_id FROM contacts WHERE user_id = ?').all(me.id).map((r) => r.contact_id);
}

/* ---------- profile & settings ---------- */

export function updateProfile(me, { name, avatarColor }) {
  const db = handle();
  const nextName = name === undefined ? me.name : String(name).trim().slice(0, 60);
  if (!nextName) bad('Name cannot be empty.');
  const nextColor = avatarColor === undefined ? me.avatar_color : String(avatarColor);
  if (!/^#[0-9a-fA-F]{6}$/.test(nextColor)) bad('Invalid colour.');
  db.prepare('UPDATE users SET name = ?, avatar_color = ? WHERE id = ?').run(nextName, nextColor, me.id);
  const updated = publicUser(auth.findById(me.id));
  rt.publish(rt.contactAudience(me.id), 'user', { user: updated });
  return updated;
}

export function saveSettings(me, settings) {
  if (!settings || typeof settings !== 'object') bad('Invalid settings.');
  handle().prepare(
    `INSERT INTO settings (user_id, json) VALUES (?,?)
     ON CONFLICT(user_id) DO UPDATE SET json = excluded.json`,
  ).run(me.id, JSON.stringify(settings));
  return { ok: true };
}

export async function setPin(me, pin) {
  if (!/^\d{4,6}$/.test(String(pin || ''))) bad('PIN must be 4–6 digits.');
  const { salt, hash } = await auth.makeSecret(pin);
  handle().prepare('UPDATE users SET pin_hash = ?, pin_salt = ? WHERE id = ?').run(hash, salt, me.id);
  return { ok: true };
}

export async function changePassword(me, current, next) {
  if (me.is_guest) throw new HttpError(400, 'Guest accounts have no password.');
  if (!(await auth.verifySecret(current, me.pw_salt, me.pw_hash))) {
    throw new HttpError(403, 'Current password is incorrect.');
  }
  if (String(next || '').length < 8) bad('New password must be at least 8 characters.');
  const { salt, hash } = await auth.makeSecret(next);
  handle().prepare('UPDATE users SET pw_hash = ?, pw_salt = ? WHERE id = ?').run(hash, salt, me.id);
  // Changing the password invalidates every other session.
  auth.destroyAllSessions(me.id);
  return { ok: true };
}

export function deleteAccount(me) {
  handle().prepare('DELETE FROM users WHERE id = ?').run(me.id);
  return { ok: true };
}

/** A guest who never spoke is removed outright; one who did is retired so
    their name still resolves in everyone else's history. */
export function releaseGuest(user) {
  const db = handle();
  const spoke = db.prepare(
    `SELECT 1 AS ok FROM messages msg
       JOIN members mem ON mem.convo_id = msg.convo_id AND mem.user_id = ?
      WHERE msg.deleted_at IS NULL
        AND (msg.from_id = ? OR msg.from_id IN (SELECT id FROM users WHERE is_bot = 0))
      LIMIT 1`,
  ).get(user.id, user.id);
  if (spoke) {
    db.prepare('UPDATE users SET retired = 1 WHERE id = ?').run(user.id);
    rt.publish(rt.contactAudience(user.id), 'user', { user: publicUser(auth.findById(user.id)) });
    return 'retired';
  }
  db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
  return 'removed';
}

export function exportData(me) {
  const data = bootstrap(me);
  return {
    exportedAt: new Date().toISOString(),
    app: 'Relay',
    user: data.me,
    settings: data.settings,
    contacts: data.contacts,
    conversations: data.conversations.map((c) => ({ ...c, messages: data.messages[c.id] })),
  };
}

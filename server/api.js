// api.js — REST handlers. Every route that touches a conversation proves the
// caller is a member of it first; nothing trusts an id from the client.

import { handle, tx, nextSeq, currentSeq, publicUser, shapeMessage, shapeConvo } from './db.js';
import * as auth from './auth.js';
import * as rt from './realtime.js';
import { scheduleBotReply, demoBotsEnabled } from './bots.js';
import * as files from './files.js';
import * as push from './push.js';

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

function loadMessages(convoId, { limit = HISTORY_LIMIT, beforeSeq = null } = {}) {
  const rows = beforeSeq
    ? handle().prepare(
      'SELECT * FROM messages WHERE convo_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?',
    ).all(convoId, beforeSeq, limit).reverse()
    : handle().prepare(
      'SELECT * FROM messages WHERE convo_id = ? ORDER BY seq DESC LIMIT ?',
    ).all(convoId, limit).reverse();

  const ids = rows.map((r) => r.id);
  const reactions = reactionsFor(ids);
  const attachments = files.forMessages(ids);
  return rows.map((r) => ({
    ...shapeMessage(r, reactions[r.id] || {}),
    attachments: attachments[r.id] || [],
  }));
}

/** Older messages for the "load earlier" control. */
export function history(me, convoId, { beforeSeq, limit }) {
  assertMember(convoId, me.id);
  const capped = Math.min(Math.max(Number(limit) || 50, 1), HISTORY_LIMIT);
  const messages = loadMessages(convoId, { limit: capped, beforeSeq: Number(beforeSeq) || null });
  const oldest = handle().prepare('SELECT MIN(seq) AS s FROM messages WHERE convo_id = ?').get(convoId)?.s ?? null;
  const hasMore = messages.length > 0 && oldest !== null && messages[0].seq > oldest;
  return { messages, hasMore };
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
  const hasMore = {};
  const reads = {};
  const meta = {};

  for (const row of convoRows) {
    conversations.push(convoWithMembers(row));
    messages[row.id] = loadMessages(row.id);
    const oldest = db.prepare('SELECT MIN(seq) AS s FROM messages WHERE convo_id = ?').get(row.id)?.s ?? null;
    hasMore[row.id] = messages[row.id].length > 0 && oldest !== null && messages[row.id][0].seq > oldest;
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
      UNION SELECT id FROM users WHERE is_bot = 1 AND ? = 1
      UNION SELECT id FROM users WHERE is_guest = 1 AND retired = 0
    ) OR u.id = ?`).all(me.id, me.id, demoBotsEnabled() ? 1 : 0, me.id);

  const settingsRow = db.prepare('SELECT json FROM settings WHERE user_id = ?').get(me.id);

  return {
    me: publicUser(me),
    users: peopleRows.map(publicUser),
    conversations,
    messages,
    hasMore,
    reads,
    meta,
    contacts: db.prepare('SELECT contact_id FROM contacts WHERE user_id = ?').all(me.id).map((r) => r.contact_id),
    settings: settingsRow ? JSON.parse(settingsRow.json) : null,
    online: rt.onlineUserIds(),
    seq: currentSeq(),
  };
}

/* ---------- people ---------- */

/**
 * Find people to start a conversation with.
 *
 * You can match on an email address — that is how you find someone whose
 * address you already know — but the address is only returned for people you
 * already have a relationship with. Otherwise any account could page through
 * this endpoint and harvest every registered address.
 */
export function searchUsers(me, q) {
  const db = handle();
  const needle = `%${String(q || '').trim().toLowerCase()}%`;
  const rows = db.prepare(`
    SELECT * FROM users
     WHERE id != ? AND retired = 0
       AND (is_bot = 0 OR ? = 1)
       AND (LOWER(name) LIKE ? OR LOWER(IFNULL(email,'')) LIKE ? OR LOWER(IFNULL(role,'')) LIKE ?)
     ORDER BY name LIMIT 50`).all(me.id, demoBotsEnabled() ? 1 : 0, needle, needle, needle);

  const known = new Set(db.prepare(`
    SELECT m2.user_id AS id FROM members m1
      JOIN members m2 ON m2.convo_id = m1.convo_id
     WHERE m1.user_id = ?
    UNION SELECT contact_id AS id FROM contacts WHERE user_id = ?`).all(me.id, me.id).map((r) => r.id));

  return rows.map((row) => {
    const user = publicUser(row);
    if (!row.is_bot && !known.has(row.id)) user.email = null;
    return user;
  });
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

/* ---------- group management ---------- */

function assertGroup(convoId) {
  const convo = handle().prepare('SELECT * FROM conversations WHERE id = ?').get(convoId);
  if (!convo) throw new HttpError(404, 'No such conversation.');
  if (convo.type !== 'group') bad('That only applies to group conversations.');
  return convo;
}

/** Tell the members their group changed, and post a note in the transcript. */
function announceGroupChange(convoId, actorId, text) {
  const convo = convoWithMembers(handle().prepare('SELECT * FROM conversations WHERE id = ?').get(convoId));
  rt.publish(convo.members, 'conversation', {
    conversation: convo,
    users: convo.members.map((u) => publicUser(auth.findById(u))).filter(Boolean),
  });
  if (text) systemMessage(convoId, actorId, text);
  return convo;
}

/**
 * A note in the transcript about the group itself. It is stored against the
 * person who caused it — messages.from_id is a foreign key — but flagged so the
 * client renders it as an event rather than as something they said.
 */
function systemMessage(convoId, actorId, text) {
  const id = auth.uid('m');
  const now = Date.now();
  const row = tx(() => {
    handle().prepare(
      `INSERT INTO messages (id, convo_id, from_id, text, at, seq, delivered_at, system)
       VALUES (?,?,?,?,?,?,?,1)`,
    ).run(id, convoId, actorId, text, now, nextSeq(), now);
    return handle().prepare('SELECT * FROM messages WHERE id = ?').get(id);
  });
  const msg = { ...shapeMessage(row), attachments: [] };
  rt.publish(rt.convoAudience(convoId), 'message', { message: msg });
  return msg;
}

export function renameGroup(me, convoId, title) {
  assertMember(convoId, me.id);
  assertGroup(convoId);
  const clean = String(title || '').trim().slice(0, 50);
  if (!clean) bad('Give the group a name.');
  handle().prepare('UPDATE conversations SET title = ? WHERE id = ?').run(clean, convoId);
  return announceGroupChange(convoId, me.id, `${me.name} renamed the group to “${clean}”.`);
}

export function addMember(me, convoId, userId) {
  assertMember(convoId, me.id);
  assertGroup(convoId);
  const invitee = auth.findById(userId);
  if (!invitee) throw new HttpError(404, 'No such person.');
  if (invitee.retired) bad('That account is no longer active.');

  const already = handle().prepare('SELECT 1 AS ok FROM members WHERE convo_id = ? AND user_id = ?')
    .get(convoId, userId);
  if (already) bad(`${invitee.name} is already in this group.`);

  handle().prepare('INSERT INTO members (convo_id, user_id) VALUES (?,?)').run(convoId, userId);
  return announceGroupChange(convoId, me.id, `${me.name} added ${invitee.name}.`);
}

export function removeMember(me, convoId, userId) {
  assertMember(convoId, me.id);
  const convo = assertGroup(convoId);
  const target = auth.findById(userId);
  if (!target) throw new HttpError(404, 'No such person.');

  const leaving = userId === me.id;
  // Anyone can leave; only the person who created the group can remove others.
  if (!leaving && convo.created_by !== me.id) {
    throw new HttpError(403, 'Only the person who created the group can remove others.');
  }

  const audience = rt.convoAudience(convoId);
  handle().prepare('DELETE FROM members WHERE convo_id = ? AND user_id = ?').run(convoId, userId);

  const remaining = handle().prepare('SELECT COUNT(*) AS c FROM members WHERE convo_id = ?').get(convoId).c;
  if (remaining === 0) {
    // Nobody left to see it.
    handle().prepare('DELETE FROM conversations WHERE id = ?').run(convoId);
    rt.publish(audience, 'conversation-removed', { convoId });
    return { removed: true };
  }

  // Attribute the note to whoever remains able to see it.
  const narrator = leaving ? (rt.convoAudience(convoId)[0] || null) : me.id;
  if (narrator) {
    systemMessage(convoId, narrator, leaving ? `${me.name} left the group.` : `${me.name} removed ${target.name}.`);
  }
  announceGroupChange(convoId, null, null);
  // The person who left needs to hear it too; they are no longer in the audience.
  if (leaving) rt.publish([me.id], 'conversation-removed', { convoId });
  return { removed: false };
}

/**
 * Notify the people who are not looking.
 *
 * Someone with a live stream already saw it, and a muted conversation should
 * stay quiet, so neither gets a notification.
 */
async function pushToAbsentMembers(convoId, sender, msg) {
  const db = handle();
  const convo = db.prepare('SELECT type, title FROM conversations WHERE id = ?').get(convoId);
  const members = db.prepare('SELECT user_id FROM members WHERE convo_id = ?').all(convoId)
    .map((r) => r.user_id)
    .filter((id) => id !== sender.id);

  const preview = msg.attachments?.length && !msg.text
    ? `Sent ${msg.attachments.length === 1 ? 'a file' : `${msg.attachments.length} files`}`
    : msg.text.slice(0, 140);

  await Promise.all(members.map(async (userId) => {
    const person = auth.findById(userId);
    if (!person || person.is_bot) return;
    if (rt.isOnline(userId)) return;

    const meta = db.prepare('SELECT muted FROM convo_meta WHERE user_id = ? AND convo_id = ?')
      .get(userId, convoId);
    if (meta?.muted) return;

    // Respect the same switch that governs in-app notifications.
    const settingsRow = db.prepare('SELECT json FROM settings WHERE user_id = ?').get(userId);
    if (settingsRow) {
      try {
        if (JSON.parse(settingsRow.json).desktopNotifs === false) return;
      } catch { /* malformed settings should not silence someone */ }
    }

    await push.notify(userId, {
      title: convo?.type === 'group' ? `${sender.name} in ${convo.title}` : sender.name,
      body: preview,
      convoId,
      messageId: msg.id,
    });
  }));
}

/* ---------- message search ---------- */

/**
 * Search the full history of every conversation the caller belongs to — not
 * only what their client happens to have loaded.
 */
export function searchMessages(me, q, limit = 40) {
  const needle = String(q || '').trim();
  if (needle.length < 2) return { results: [] };
  const capped = Math.min(Math.max(Number(limit) || 40, 1), 100);
  const like = `%${needle.toLowerCase()}%`;

  const rows = handle().prepare(`
    SELECT m.*, c.type AS convo_type, c.title AS convo_title
      FROM messages m
      JOIN members mem ON mem.convo_id = m.convo_id AND mem.user_id = ?
      JOIN conversations c ON c.id = m.convo_id
      LEFT JOIN convo_meta meta ON meta.convo_id = m.convo_id AND meta.user_id = ?
     WHERE m.deleted_at IS NULL
       AND LOWER(m.text) LIKE ?
       AND m.at > IFNULL(meta.cleared_before, 0)
     ORDER BY m.at DESC
     LIMIT ?`).all(me.id, me.id, like, capped);

  return {
    results: rows.map((r) => ({
      ...shapeMessage(r),
      convoType: r.convo_type,
      convoTitle: r.convo_title,
    })),
  };
}

/* ---------- messages ---------- */

export function sendMessage(me, convoId, { text, replyTo, clientId, attachmentIds = [] }) {
  assertMember(convoId, me.id);
  const clean = String(text ?? '').trim();
  const wanted = Array.isArray(attachmentIds) ? attachmentIds.filter((x) => typeof x === 'string') : [];
  if (!clean && !wanted.length) bad('Message is empty.');
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

  const attachments = wanted.length ? files.attach(wanted, id, convoId, me.id) : [];
  const msg = { ...shapeMessage(row), attachments };
  rt.publish(rt.convoAudience(convoId), 'message', { message: msg, clientId });
  scheduleBotReply(convoId, msg);
  // Fire and forget: a slow push service must not delay the sender's response.
  pushToAbsentMembers(convoId, me, msg).catch(() => {});
  return msg;
}

export function editMessage(me, msgId, text) {
  const row = ownMessage(msgId, me.id);
  if (row.deleted_at) bad('That message was deleted.');
  const clean = String(text ?? '').trim();
  if (!clean) bad('Message is empty.');
  if (clean.length > MAX_TEXT) bad(`Messages are limited to ${MAX_TEXT} characters.`);
  handle().prepare('UPDATE messages SET text = ?, edited_at = ? WHERE id = ?').run(clean, Date.now(), msgId);
  const msg = {
    ...shapeMessage(handle().prepare('SELECT * FROM messages WHERE id = ?').get(msgId)),
    attachments: files.forMessages([msgId])[msgId] || [],
  };
  rt.publish(rt.convoAudience(row.convo_id), 'message-updated', { message: msg });
  return msg;
}

export async function deleteMessage(me, msgId) {
  const row = ownMessage(msgId, me.id);
  handle().prepare('UPDATE messages SET deleted_at = ?, text = ? WHERE id = ?').run(Date.now(), '', msgId);
  // Deleting a message deletes its files too, not just the reference to them.
  await files.removeForMessage(msgId);
  const msg = { ...shapeMessage(handle().prepare('SELECT * FROM messages WHERE id = ?').get(msgId)), attachments: [] };
  rt.publish(rt.convoAudience(row.convo_id), 'message-updated', { message: msg });
  return msg;
}

/** Membership check used by the upload and download routes. */
export function assertConvoMember(convoId, userId) { assertMember(convoId, userId); }

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
  const msg = {
    ...shapeMessage(row, reactionsFor([msgId])[msgId] || {}),
    attachments: files.forMessages([msgId])[msgId] || [],
  };
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

export const PROFILE_LIMITS = { name: 60, pronouns: 24, title: 60, bio: 280, statusText: 80, statusEmoji: 8 };

/** Trim to a limit, and treat an all-whitespace value as clearing the field. */
function optionalText(value, limit) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const clean = String(value).replace(/\s+/g, ' ').trim().slice(0, limit);
  return clean || null;
}

export function updateProfile(me, patch = {}) {
  const db = handle();

  const nextName = patch.name === undefined
    ? me.name
    : String(patch.name).replace(/\s+/g, ' ').trim().slice(0, PROFILE_LIMITS.name);
  if (!nextName) bad('Name cannot be empty.');

  const nextColor = patch.avatarColor === undefined ? me.avatar_color : String(patch.avatarColor);
  if (!/^#[0-9a-fA-F]{6}$/.test(nextColor)) bad('Invalid colour.');

  const fields = {
    pronouns: optionalText(patch.pronouns, PROFILE_LIMITS.pronouns),
    title: optionalText(patch.title, PROFILE_LIMITS.title),
    bio: optionalText(patch.bio, PROFILE_LIMITS.bio),
    status_text: optionalText(patch.statusText, PROFILE_LIMITS.statusText),
    status_emoji: optionalText(patch.statusEmoji, PROFILE_LIMITS.statusEmoji),
  };

  if (patch.timezone !== undefined) {
    const tz = patch.timezone === null ? null : String(patch.timezone).slice(0, 64);
    // Reject anything Intl will not accept, rather than storing a bad zone that
    // breaks time rendering for whoever views the profile.
    if (tz) {
      try { new Intl.DateTimeFormat('en', { timeZone: tz }); }
      catch { bad('Unknown time zone.'); }
    }
    fields.timezone = tz;
  }

  if (patch.statusUntil !== undefined) {
    const until = patch.statusUntil === null ? null : Number(patch.statusUntil);
    if (until !== null && (!Number.isFinite(until) || until < Date.now())) bad('Status expiry must be in the future.');
    fields.status_until = until;
  }
  // Clearing the status text should not leave an orphan expiry behind.
  if (fields.status_text === null && patch.statusUntil === undefined) fields.status_until = null;

  const sets = ['name = ?', 'avatar_color = ?', 'updated_at = ?'];
  const values = [nextName, nextColor, Date.now()];
  for (const [column, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    sets.push(`${column} = ?`);
    values.push(value);
  }
  db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...values, me.id);

  const updated = publicUser(auth.findById(me.id));
  rt.publish(rt.contactAudience(me.id), 'user', { user: updated });
  return updated;
}

/**
 * One person's profile, as this viewer is allowed to see it. Email follows the
 * same rule as directory search: shown only to people already connected.
 */
export function getProfile(me, userId) {
  const db = handle();
  const row = auth.findById(userId);
  if (!row) throw new HttpError(404, 'No such person.');

  const shared = db.prepare(
    `SELECT c.id, c.type, c.title FROM conversations c
       JOIN members m1 ON m1.convo_id = c.id AND m1.user_id = ?
       JOIN members m2 ON m2.convo_id = c.id AND m2.user_id = ?
      ORDER BY c.created_at`,
  ).all(me.id, userId);

  const isContact = !!db.prepare('SELECT 1 AS ok FROM contacts WHERE user_id = ? AND contact_id = ?')
    .get(me.id, userId);

  const user = publicUser(row);
  if (!row.is_bot && !shared.length && !isContact && row.id !== me.id) user.email = null;

  return {
    user,
    isSelf: row.id === me.id,
    isContact,
    online: rt.isOnline(row.id) || !!row.is_bot,
    sharedConversations: shared.map((c) => ({ id: c.id, type: c.type, title: c.title })),
    directConversationId: shared.find((c) => c.type === 'dm')?.id || null,
  };
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

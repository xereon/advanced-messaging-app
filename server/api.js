// api.js — REST handlers. Every route that touches a conversation proves the
// caller is a member of it first; nothing trusts an id from the client.

import { handle, tx, nextSeq, currentSeq, publicUser, selfUser, shapeMessage, shapeConvo } from './db.js';
import * as auth from './auth.js';
import * as rt from './realtime.js';
import { scheduleBotReply, demoBotsEnabled } from './bots.js';
import * as files from './files.js';
import * as push from './push.js';
import { normalizeUsername, usernameProblem } from './username.js';
import { ADMIN_PATH } from './admin.js';

const MAX_TEXT = 4000;
const HISTORY_LIMIT = 200;

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (msg) => { throw new HttpError(400, msg); };

/* ---------- helpers ---------- */

/**
 * Membership, plus the block rule, for every route that touches a conversation.
 *
 * A block takes the direct conversation out of both snapshots, so everything
 * else has to agree: history paging, reactions, receipts and typing all run
 * through here. Without that, a client could keep working a thread the server
 * has told it does not exist. Groups are deliberately unaffected — blocking is
 * a direct-message tool, not a way to silence someone in a shared room.
 *
 * Both refusals use one message. A blocked person sees exactly what a stranger
 * sees, so the response cannot be used to detect a block.
 */
function assertMember(convoId, userId) {
  const row = handle().prepare('SELECT 1 AS ok FROM members WHERE convo_id = ? AND user_id = ?')
    .get(convoId, userId);
  if (!row) throw new HttpError(403, 'This conversation is not available.');

  const convo = handle().prepare('SELECT type FROM conversations WHERE id = ?').get(convoId);
  if (convo?.type !== 'dm') return;
  const other = handle().prepare('SELECT user_id FROM members WHERE convo_id = ? AND user_id != ?')
    .get(convoId, userId)?.user_id;
  if (other && isBlockedBetween(userId, other)) {
    throw new HttpError(403, 'This conversation is not available.');
  }
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

function loadMessages(convoId, { limit = HISTORY_LIMIT, beforeSeq = null, hidden = null } = {}) {
  const rows = beforeSeq
    ? handle().prepare(
      'SELECT * FROM messages WHERE convo_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?',
    ).all(convoId, beforeSeq, limit).reverse()
    : handle().prepare(
      'SELECT * FROM messages WHERE convo_id = ? ORDER BY seq DESC LIMIT ?',
    ).all(convoId, limit).reverse();

  // Blocking hides history as well as new arrivals — otherwise the person you
  // blocked stays visible in every group you share.
  const visible = hidden?.size ? rows.filter((r) => !hidden.has(r.from_id)) : rows;
  const ids = visible.map((r) => r.id);
  const reactions = reactionsFor(ids);
  const attachments = files.forMessages(ids);
  return visible.map((r) => ({
    ...shapeMessage(r, reactions[r.id] || {}),
    attachments: attachments[r.id] || [],
  }));
}

/** Older messages for the "load earlier" control. */
export function history(me, convoId, { beforeSeq, limit }) {
  assertMember(convoId, me.id);
  const capped = Math.min(Math.max(Number(limit) || 50, 1), HISTORY_LIMIT);
  const messages = loadMessages(convoId, {
    limit: capped, beforeSeq: Number(beforeSeq) || null, hidden: blockedIdsFor(me.id),
  });
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
  const hidden = blockedIdsFor(me.id);

  for (const row of convoRows) {
    // A direct conversation with someone blocked is not shown at all.
    if (row.type === 'dm') {
      const other = db.prepare('SELECT user_id FROM members WHERE convo_id = ? AND user_id != ?')
        .get(row.id, me.id)?.user_id;
      if (other && hidden.has(other)) continue;
    }
    conversations.push(convoWithMembers(row));
    messages[row.id] = loadMessages(row.id, { hidden });
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
    // An administrator is told where the dashboard is. Nobody else learns that
    // there is one to be told about.
    me: me.is_admin && !me.is_guest
      ? { ...selfUser(me), adminUrl: ADMIN_PATH }
      : selfUser(me),
    users: peopleRows.map(publicUser),
    conversations,
    messages,
    hasMore,
    reads,
    meta,
    contacts: db.prepare('SELECT contact_id FROM contacts WHERE user_id = ?').all(me.id).map((r) => r.contact_id),
    blocked: blockedList(me.id),
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
/**
 * How much you must type before the directory answers at all.
 *
 * A blank query used to return the whole user list, which made every account on
 * the server browsable by anyone who opened the New chat dialog. Search should
 * confirm a person you are already looking for, not hand out the membership
 * list. Three characters is enough to find someone you know of and far too few
 * to walk the directory.
 */
export const DIRECTORY_MIN_QUERY = 3;

/**
 * Make a user-typed string safe to drop into a LIKE pattern.
 *
 * `_` matches any single character in SQL, and usernames are allowed to contain
 * it — so searching for `ada_l` would also match `adaxl` and, worse, an
 * underscore typed by someone probing for near-miss handles would quietly widen
 * their search. `%` has the same problem at a larger scale.
 */
const likeLiteral = (s) => String(s).replace(/[\\%_]/g, '\\$&');

/**
 * Find people.
 *
 * Matching is deliberately anchored rather than "contains anywhere":
 *
 *   - **username** — prefix. Handles are the thing you are meant to search by.
 *   - **name** — prefix of any word, so "smith" still finds "John Smith" while
 *     "ohn" no longer sweeps up every name with those letters inside it.
 *   - **email** — exact address only. A substring match let you probe for
 *     addresses you had no business knowing; you now have to already have it.
 *   - **role** — prefix of any word, same reasoning as name.
 */
export function searchUsers(me, q) {
  const db = handle();
  const raw = String(q || '').trim();
  // A leading @ is how people write a handle; it is not part of one.
  const term = raw.replace(/^@+/, '').toLowerCase();
  if (term.length < DIRECTORY_MIN_QUERY) return { users: [], minQuery: DIRECTORY_MIN_QUERY };

  const literal = likeLiteral(term);
  const prefix = `${literal}%`;
  const wordPrefix = `% ${literal}%`;
  const hidden = blockedIdsFor(me.id);
  const rows = db.prepare(`
    SELECT * FROM users
     WHERE id != ? AND retired = 0
       AND (is_bot = 0 OR ? = 1)
       AND (LOWER(IFNULL(username,'')) LIKE ? ESCAPE '\\'
         OR LOWER(name) LIKE ? ESCAPE '\\' OR LOWER(name) LIKE ? ESCAPE '\\'
         OR LOWER(IFNULL(role,'')) LIKE ? ESCAPE '\\' OR LOWER(IFNULL(role,'')) LIKE ? ESCAPE '\\'
         OR LOWER(IFNULL(email,'')) = ?)
     ORDER BY name LIMIT 50`)
    .all(me.id, demoBotsEnabled() ? 1 : 0, prefix, prefix, wordPrefix, prefix, wordPrefix, term);

  const known = new Set(db.prepare(`
    SELECT m2.user_id AS id FROM members m1
      JOIN members m2 ON m2.convo_id = m1.convo_id
     WHERE m1.user_id = ?
    UNION SELECT contact_id AS id FROM contacts WHERE user_id = ?`).all(me.id, me.id).map((r) => r.id));

  const users = rows
    // Someone you blocked, or who blocked you, is simply not in the directory.
    .filter((row) => !hidden.has(row.id))
    .map((row) => {
      const user = publicUser(row);
      if (!row.is_bot && !known.has(row.id)) user.email = null;
      return user;
    })
    // An exact handle is an unambiguous request for one person. Put them first
    // rather than alphabetically among everyone who merely starts the same.
    .sort((a, b) => (b.username === term) - (a.username === term));

  return { users, minQuery: DIRECTORY_MIN_QUERY };
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
    // Neither side can open a thread across a block. Refusing here means the
    // client never gets a conversation it would immediately fail to post to.
    if (isBlockedBetween(ids[0], ids[1])) throw new HttpError(403, 'This conversation is not available.');
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

/* ---------- blocking ---------- */

/**
 * Everyone in a block relationship with this account, in either direction.
 *
 * Enforcement is symmetric on purpose. If it only worked one way, blocking
 * someone would stop them reaching you but leave you seeing their messages —
 * and the person you blocked could tell, because their view would change.
 */
export function blockedIdsFor(userId) {
  const rows = handle().prepare(
    `SELECT blocked_id AS id FROM blocks WHERE user_id = ?
     UNION SELECT user_id AS id FROM blocks WHERE blocked_id = ?`,
  ).all(userId, userId);
  return new Set(rows.map((r) => r.id));
}

export function isBlockedBetween(a, b) {
  return !!handle().prepare(
    `SELECT 1 AS ok FROM blocks
      WHERE (user_id = ? AND blocked_id = ?) OR (user_id = ? AND blocked_id = ?) LIMIT 1`,
  ).get(a, b, b, a);
}

export function blockUser(me, targetId) {
  if (targetId === me.id) bad('You cannot block yourself.');
  const target = auth.findById(targetId);
  if (!target) throw new HttpError(404, 'No such person.');

  handle().prepare('INSERT OR IGNORE INTO blocks (user_id, blocked_id, created_at) VALUES (?,?,?)')
    .run(me.id, targetId, Date.now());
  // Blocking implies you no longer want them as a contact.
  handle().prepare('DELETE FROM contacts WHERE user_id = ? AND contact_id = ?').run(me.id, targetId);

  // Both sides need their view rebuilt; neither is told why.
  rt.publish([me.id], 'blocks', { blocked: blockedList(me.id) });
  rt.publish([targetId], 'refresh', {});
  return { blocked: blockedList(me.id) };
}

export function unblockUser(me, targetId) {
  handle().prepare('DELETE FROM blocks WHERE user_id = ? AND blocked_id = ?').run(me.id, targetId);
  rt.publish([me.id], 'blocks', { blocked: blockedList(me.id) });
  rt.publish([targetId], 'refresh', {});
  return { blocked: blockedList(me.id) };
}

/** Only the people *you* blocked — not the ones who blocked you. */
export function blockedList(userId) {
  return handle().prepare('SELECT blocked_id FROM blocks WHERE user_id = ?')
    .all(userId).map((r) => r.blocked_id);
}

/**
 * The block list with names attached.
 *
 * Blocking hides someone everywhere else, which would otherwise leave no route
 * back to the profile that holds the Unblock button. This is that route, and it
 * is the one place a blocked account is still named — to the person who blocked
 * them, who already knows.
 */
export function blockedUsers(me) {
  const rows = handle().prepare(
    `SELECT u.* FROM blocks b JOIN users u ON u.id = b.blocked_id
      WHERE b.user_id = ? ORDER BY b.created_at DESC`,
  ).all(me.id);
  return { blocked: rows.map(publicUser) };
}

/* ---------- reporting ---------- */

const REPORT_REASONS = new Set(['spam', 'harassment', 'impersonation', 'inappropriate', 'other']);

export function submitReport(me, { subjectId, convoId, messageId, reason, note }) {
  if (!REPORT_REASONS.has(reason)) bad('Choose a reason.');
  const subject = auth.findById(subjectId);
  if (!subject) throw new HttpError(404, 'No such person.');
  if (subjectId === me.id) bad('You cannot report yourself.');

  // Snapshot the message, if one was cited and the reporter can actually see it.
  let messageText = null;
  if (messageId) {
    const row = handle().prepare('SELECT * FROM messages WHERE id = ?').get(messageId);
    if (row) {
      assertMember(row.convo_id, me.id);
      messageText = row.text;
    }
  }

  const id = auth.uid('r');
  handle().prepare(
    `INSERT INTO reports (id, reporter_id, subject_id, convo_id, message_id, message_text,
                          reason, note, status, created_at)
     VALUES (?,?,?,?,?,?,?,?,'open',?)`,
  ).run(id, me.id, subjectId, convoId || null, messageId || null, messageText,
    reason, String(note || '').slice(0, 1000) || null, Date.now());

  return { id, ok: true };
}

// Reading and resolving reports lives in admin.js, which answers 404 rather
// than 403 so the moderation surface does not confirm its own existence.

/* ---------- feedback ---------- */

const FEEDBACK_KINDS = new Set(['idea', 'bug', 'accessibility', 'praise', 'other']);
const MAX_FEEDBACK = 2000;

/**
 * Feedback from the account menu.
 *
 * The author's display name is copied in rather than only referenced. Feedback
 * outlives the session it was written in — someone may act on it months later —
 * and a row that reads "from a deleted account" with no name attached is not
 * something you can follow up on.
 *
 * Nothing about the browser or the account beyond the name is collected. A bug
 * report is worth less without a user agent, and asking is a better trade than
 * quietly gathering one.
 */
export function submitFeedback(me, { kind, message }) {
  if (!FEEDBACK_KINDS.has(kind)) bad('Choose what kind of feedback this is.');
  const text = String(message ?? '').trim().slice(0, MAX_FEEDBACK);
  if (!text) bad('Say a little about it first.');

  const id = auth.uid('fb');
  handle().prepare(
    `INSERT INTO feedback (id, author_id, author_name, kind, message, status, created_at)
     VALUES (?,?,?,?,?,'new',?)`,
  ).run(id, me.id, me.name, kind, text, Date.now());
  return { id, ok: true };
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

    if (isBlockedBetween(sender.id, userId)) return;
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
  // Searching for "a_b" must find that literal text, not "axb".
  const like = `%${likeLiteral(needle.toLowerCase())}%`;

  const rows = handle().prepare(`
    SELECT m.*, c.type AS convo_type, c.title AS convo_title
      FROM messages m
      JOIN members mem ON mem.convo_id = m.convo_id AND mem.user_id = ?
      JOIN conversations c ON c.id = m.convo_id
      LEFT JOIN convo_meta meta ON meta.convo_id = m.convo_id AND meta.user_id = ?
     WHERE m.deleted_at IS NULL
       AND m.from_id NOT IN (SELECT blocked_id FROM blocks WHERE user_id = ?)
       AND m.from_id NOT IN (SELECT user_id FROM blocks WHERE blocked_id = ?)
       AND LOWER(m.text) LIKE ? ESCAPE '\\'
       AND m.at > IFNULL(meta.cleared_before, 0)
     ORDER BY m.at DESC
     LIMIT ?`).all(me.id, me.id, me.id, me.id, like, capped);

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
  assertMember(convoId, me.id);   // also closes a direct conversation with a block

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
  // In a shared group both people stay members, but neither receives the
  // other's messages.
  const blocked = blockedIdsFor(me.id);
  const audience = rt.convoAudience(convoId).filter((u) => u === me.id || !blocked.has(u));
  rt.publish(audience, 'message', { message: msg, clientId });
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

/**
 * The username this profile update should end up with.
 *
 * Returns `undefined` when the field was not part of the patch, so an update
 * that only touches a bio does not rewrite the handle. Unchanged is allowed
 * through without a uniqueness complaint — otherwise saving the form twice
 * would tell you your own handle was taken.
 */
function nextUsername(me, value) {
  if (value === undefined) return undefined;
  const wanted = normalizeUsername(value);
  if (wanted === (me.username || '')) return undefined;

  const problem = usernameProblem(wanted);
  if (problem) bad(problem);
  const clash = handle().prepare('SELECT 1 AS ok FROM users WHERE username = ? AND id != ?')
    .get(wanted, me.id);
  if (clash) throw new HttpError(409, 'That username is already taken.');
  return wanted;
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
    username: nextUsername(me, patch.username),
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

  const iBlockedThem = !!db.prepare('SELECT 1 AS ok FROM blocks WHERE user_id = ? AND blocked_id = ?')
    .get(me.id, userId);
  const theyBlockedMe = !!db.prepare('SELECT 1 AS ok FROM blocks WHERE user_id = ? AND blocked_id = ?')
    .get(userId, me.id);
  // Being blocked is not disclosed: to you it simply looks like they are gone.
  if (theyBlockedMe && !iBlockedThem) throw new HttpError(404, 'No such person.');

  const user = publicUser(row);
  if (!row.is_bot && !shared.length && !isContact && row.id !== me.id) user.email = null;

  return {
    user,
    isSelf: row.id === me.id,
    isContact,
    isBlocked: iBlockedThem,
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

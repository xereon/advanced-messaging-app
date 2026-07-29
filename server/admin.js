// admin.js — the moderation dashboard's server side.
//
// Two rules shape everything here.
//
// **Nothing confirms that this exists.** A caller who is not an administrator
// gets the router's own 404 — the same status and the same body as any unknown
// path. Not 401, not 403: those answer "there is something here, and you are not
// allowed in", which is a map of what to attack next. A 404 does not.
//
// **There is no way to become an administrator over HTTP.** No route in the app
// writes `users.is_admin`. It is set from the environment on boot or by
// `npm run admin`, both of which need access to the server itself, so a
// compromised session cannot escalate — it can only do what that account could
// already do.

import { handle } from './db.js';
import * as auth from './auth.js';

const REPORT_STATUSES = ['open', 'reviewed', 'actioned', 'dismissed'];

/**
 * Where the dashboard lives, told only to administrators.
 *
 * Kept here rather than written into the app's markup or its script, both of
 * which are served to everyone: an ordinary user reading either should find no
 * mention of a moderation page. Guessing the path still gets them the app shell
 * and nothing else, so this is tidiness rather than a defence.
 */
export const ADMIN_PATH = '/admin';

/**
 * A refusal that is indistinguishable from the path not existing.
 *
 * Thrown for anyone who is not an administrator, including signed-out callers,
 * so probing the admin surface tells you nothing about whether it is there or
 * about which account holds the flag.
 */
export class NotFound extends Error {
  constructor() { super('Unknown endpoint.'); this.status = 404; }
}

/**
 * Confirm the caller is an administrator, reading the flag from the database.
 *
 * The session row is passed in, but the flag is re-read rather than trusted
 * from it: revoking admin has to take effect on the next request, not whenever
 * that session happens to expire.
 *
 * Guests are excluded unconditionally. A guest session is handed out to whoever
 * asks, so it must never be a route to moderation tooling even if the flag were
 * somehow set on one.
 */
export function requireAdmin(me) {
  if (!me) throw new NotFound();
  const row = handle().prepare('SELECT is_admin, is_guest, name FROM users WHERE id = ?').get(me.id);
  if (!row || !row.is_admin || row.is_guest) throw new NotFound();
  return row;
}

export const isAdmin = (me) => {
  try { requireAdmin(me); return true; } catch { return false; }
};

/* ---------- audit trail ---------- */

/**
 * Record an administrator's action.
 *
 * Written before the caller is told the action succeeded, so a failure to log
 * fails the request. An unlogged moderation action is worse than a refused one:
 * the record is the only thing that makes the power accountable.
 */
export function logAction(me, action, { targetType = null, targetId = null, detail = null, ip = null } = {}) {
  handle().prepare(
    `INSERT INTO admin_audit (id, actor_id, actor_name, action, target_type, target_id, detail, ip, at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(auth.uid('al'), me.id, me.name, action, targetType, targetId,
    detail === null ? null : String(detail).slice(0, 500), ip, Date.now());
}

export function listAudit(me, limit = 100) {
  requireAdmin(me);
  const capped = Math.min(Math.max(Number(limit) || 100, 1), 500);
  return {
    entries: handle().prepare('SELECT * FROM admin_audit ORDER BY at DESC LIMIT ?').all(capped),
  };
}

/* ---------- overview ---------- */

/**
 * The numbers on the dashboard's first screen.
 *
 * Counts only. A moderation tool has no business rendering the message table,
 * and an overview that did would turn one compromised admin session into a dump
 * of everybody's conversations.
 */
export function overview(me) {
  requireAdmin(me);
  const db = handle();
  const one = (sql, ...args) => db.prepare(sql).get(...args)?.n ?? 0;
  const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;

  return {
    reports: {
      open: one("SELECT COUNT(*) AS n FROM reports WHERE status = 'open'"),
      reviewed: one("SELECT COUNT(*) AS n FROM reports WHERE status = 'reviewed'"),
      actioned: one("SELECT COUNT(*) AS n FROM reports WHERE status = 'actioned'"),
      dismissed: one("SELECT COUNT(*) AS n FROM reports WHERE status = 'dismissed'"),
      lastDay: one('SELECT COUNT(*) AS n FROM reports WHERE created_at > ?', dayAgo),
    },
    feedback: {
      unread: one("SELECT COUNT(*) AS n FROM feedback WHERE status = 'new'"),
      total: one('SELECT COUNT(*) AS n FROM feedback'),
      lastWeek: one('SELECT COUNT(*) AS n FROM feedback WHERE created_at > ?', weekAgo),
    },
    accounts: {
      total: one('SELECT COUNT(*) AS n FROM users WHERE is_bot = 0'),
      registered: one('SELECT COUNT(*) AS n FROM users WHERE is_bot = 0 AND is_guest = 0'),
      guests: one('SELECT COUNT(*) AS n FROM users WHERE is_guest = 1 AND retired = 0'),
      admins: one('SELECT COUNT(*) AS n FROM users WHERE is_admin = 1'),
      newThisWeek: one('SELECT COUNT(*) AS n FROM users WHERE is_bot = 0 AND created_at > ?', weekAgo),
      activeToday: one('SELECT COUNT(*) AS n FROM users WHERE last_seen > ?', dayAgo),
    },
    activity: {
      conversations: one('SELECT COUNT(*) AS n FROM conversations'),
      messages: one('SELECT COUNT(*) AS n FROM messages WHERE deleted_at IS NULL'),
      messagesToday: one('SELECT COUNT(*) AS n FROM messages WHERE at > ?', dayAgo),
      attachments: one('SELECT COUNT(*) AS n FROM attachments'),
      blocks: one('SELECT COUNT(*) AS n FROM blocks'),
      pushSubscriptions: one('SELECT COUNT(*) AS n FROM push_subscriptions'),
    },
  };
}

/* ---------- the report queue ---------- */

/**
 * Reports, newest first, with the context needed to judge one.
 *
 * `subjectReports` is the count of *other* open reports naming the same person,
 * which is usually the difference between one bad exchange and a pattern. The
 * quoted message comes from the snapshot taken when the report was filed, so
 * this reads no live conversation content.
 */
export function listReports(me, { status = 'open', limit = 100 } = {}) {
  requireAdmin(me);
  const capped = Math.min(Math.max(Number(limit) || 100, 1), 200);
  const db = handle();

  const where = status === 'all' ? '' : 'WHERE r.status = ?';
  const args = status === 'all' ? [] : [status];
  if (status !== 'all' && !REPORT_STATUSES.includes(status)) {
    const err = new Error('Unknown status.');
    err.status = 400;
    throw err;
  }

  const rows = db.prepare(`
    SELECT r.id, r.reason, r.note, r.status, r.created_at, r.message_text, r.convo_id,
           r.reporter_id, r.subject_id,
           reporter.name AS reporter_name, reporter.username AS reporter_username,
           subject.name AS subject_name, subject.username AS subject_username,
           subject.email AS subject_email, subject.created_at AS subject_joined,
           subject.is_guest AS subject_is_guest
      FROM reports r
      LEFT JOIN users reporter ON reporter.id = r.reporter_id
      LEFT JOIN users subject ON subject.id = r.subject_id
     ${where}
     ORDER BY r.created_at DESC LIMIT ?`).all(...args, capped);

  const countOthers = db.prepare(
    "SELECT COUNT(*) AS n FROM reports WHERE subject_id = ? AND id != ? AND status != 'dismissed'",
  );

  return {
    reports: rows.map((r) => ({
      id: r.id,
      reason: r.reason,
      note: r.note,
      status: r.status,
      createdAt: r.created_at,
      quotedMessage: r.message_text,
      inConversation: !!r.convo_id,
      reporter: r.reporter_id
        ? { id: r.reporter_id, name: r.reporter_name, username: r.reporter_username }
        : null,
      subject: r.subject_id
        ? {
          id: r.subject_id,
          name: r.subject_name,
          username: r.subject_username,
          email: r.subject_email,
          joined: r.subject_joined,
          isGuest: !!r.subject_is_guest,
          otherReports: countOthers.get(r.subject_id, r.id)?.n ?? 0,
        }
        : null,
    })),
    statuses: REPORT_STATUSES,
  };
}

/* ---------- feedback ---------- */

const FEEDBACK_STATUSES = ['new', 'read', 'planned', 'done', 'declined'];

export function listFeedback(me, { status = 'new', limit = 100 } = {}) {
  requireAdmin(me);
  if (status !== 'all' && !FEEDBACK_STATUSES.includes(status)) {
    const err = new Error('Unknown status.');
    err.status = 400;
    throw err;
  }
  const capped = Math.min(Math.max(Number(limit) || 100, 1), 200);
  const where = status === 'all' ? '' : 'WHERE f.status = ?';
  const args = status === 'all' ? [] : [status];

  const rows = handle().prepare(`
    SELECT f.*, u.username AS author_username, u.email AS author_email
      FROM feedback f LEFT JOIN users u ON u.id = f.author_id
     ${where}
     ORDER BY f.created_at DESC LIMIT ?`).all(...args, capped);

  return {
    feedback: rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      message: r.message,
      status: r.status,
      createdAt: r.created_at,
      // author_id goes null when the account is deleted; the name stays, so say
      // plainly that they are gone rather than showing a name that resolves to
      // nobody.
      author: {
        id: r.author_id,
        name: r.author_name,
        username: r.author_username,
        email: r.author_email,
        deleted: !r.author_id,
      },
    })),
    statuses: FEEDBACK_STATUSES,
  };
}

export function resolveFeedback(me, id, status, { ip = null } = {}) {
  const actor = requireAdmin(me);
  if (!FEEDBACK_STATUSES.includes(status)) {
    const err = new Error('Unknown status.');
    err.status = 400;
    throw err;
  }
  const before = handle().prepare('SELECT status FROM feedback WHERE id = ?').get(id);
  if (!before) throw new NotFound();

  logAction({ id: me.id, name: actor.name }, 'feedback.resolve', {
    targetType: 'feedback', targetId: id, detail: `${before.status} → ${status}`, ip,
  });
  handle().prepare('UPDATE feedback SET status = ? WHERE id = ?').run(status, id);
  return { ok: true, id, status };
}

export function resolveReport(me, id, status, { ip = null } = {}) {
  const actor = requireAdmin(me);
  if (!REPORT_STATUSES.includes(status)) {
    const err = new Error('Unknown status.');
    err.status = 400;
    throw err;
  }
  const before = handle().prepare('SELECT status, subject_id FROM reports WHERE id = ?').get(id);
  if (!before) throw new NotFound();

  logAction({ id: me.id, name: actor.name }, 'report.resolve', {
    targetType: 'report',
    targetId: id,
    detail: `${before.status} → ${status}`,
    ip,
  });
  handle().prepare('UPDATE reports SET status = ? WHERE id = ?').run(status, id);
  return { ok: true, id, status };
}

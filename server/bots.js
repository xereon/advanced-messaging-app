// bots.js — the simulated colleagues, now real rows in the database that reply
// server-side, so their messages reach every connected client.

import { handle, tx, nextSeq, shapeMessage } from './db.js';
import { uid } from './auth.js';
import * as rt from './realtime.js';

export const BOTS = [
  { id: 'u-bot-ava', name: 'Ava Chen', role: 'Product Manager', color: '#7C4DDB',
    flavor: ['Roadmap review moved to Thursday, by the way.',
             'I put the latest figures in the shared drive.',
             'The client demo went really well today.'] },
  { id: 'u-bot-marcus', name: 'Marcus Webb', role: 'IT Helpdesk', color: '#0E7490',
    flavor: ['Ticket logged — reference #4821.',
             'The VPN maintenance window is Friday 22:00.',
             'Have you tried signing out and back in?'] },
  { id: 'u-bot-priya', name: 'Priya Sharma', role: 'People Ops', color: '#B0367A',
    flavor: ['Reminder: benefits enrolment closes at the end of the month.',
             'I have booked the quiet room for your 1:1.',
             'New starters arrive Monday — fancy joining the welcome lunch?'] },
  { id: 'u-bot-leo', name: 'Leo Fontaine', role: 'Design Lead', color: '#B45309',
    flavor: ['Pushed the new tokens to the design system.',
             'That contrast ratio passes AA now, checked it twice.',
             'Prototype link is in the project channel.'] },
];

const RULES = [
  { re: /\b(hi|hey|hello|morning|afternoon)\b/i, pool: ['Hey! How is your day going?', 'Hello! Good timing, I was about to ping you.', 'Hi there 👋'] },
  { re: /\b(thanks|thank you|cheers)\b/i, pool: ['Anytime!', 'No problem at all.', 'Happy to help 👍'] },
  { re: /\b(meeting|call|standup|stand-up|sync)\b/i, pool: ['I can do 2 pm or anytime after 4, your pick.', 'Calendar invite sent.', 'Let us keep it to 25 minutes if we can.'] },
  { re: /\b(report|numbers|figures|metrics|quarter)\b/i, pool: ['The dashboard refreshed an hour ago.', 'Headline: up 12% on last quarter.', 'I will have the summary ready before end of day.'] },
  { re: /\b(bug|broken|error|crash|issue)\b/i, pool: ['Can you send a screenshot? I will raise it now.', 'Reproduced it on my side too — escalating.', 'A fix is already in review.'] },
  { re: /\b(deadline|due|late|schedule|timeline)\b/i, pool: ['We are still on track for Friday.', 'Better to flag it today rather than Thursday.', 'I built a day of buffer into the plan.'] },
  { re: /\?\s*$/, pool: ['Good question — let me check and come back to you.', 'Short answer: yes.', 'I think so, but let me confirm with the team first.'] },
];

const GENERIC = [
  'Got it, thanks for the heads-up.', 'Makes sense to me.', 'Understood — I will factor that in.',
  'Noted 👍', 'Sounds good. Anything you need from me?', 'Right, that matches what I heard too.',
];

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

export function seedBots() {
  const db = handle();
  const ins = db.prepare(
    `INSERT OR IGNORE INTO users (id, name, email, avatar_color, role, is_bot, created_at, last_seen)
     VALUES (?,?,?,?,?,1,?,?)`,
  );
  const now = Date.now();
  for (const b of BOTS) {
    ins.run(b.id, b.name, `${b.name.split(' ')[0].toLowerCase()}@relay.demo`, b.color, b.role, now, now);
  }
}

/** First-run conversations so a new account lands in a lived-in workspace. */
export function seedConversationsFor(userId, displayName) {
  const db = handle();
  const now = Date.now();
  const first = String(displayName || '').split(' ')[0] || 'there';

  const dm = (botId, text, offset) => {
    const id = 'dm:' + [userId, botId].sort().join('~');
    if (db.prepare('SELECT 1 AS ok FROM conversations WHERE id = ?').get(id)) return;
    tx(() => {
      db.prepare('INSERT INTO conversations (id, type, created_at, created_by) VALUES (?,?,?,?)')
        .run(id, 'dm', now, botId);
      const m = db.prepare('INSERT OR IGNORE INTO members (convo_id, user_id) VALUES (?,?)');
      m.run(id, userId); m.run(id, botId);
      db.prepare(
        `INSERT INTO messages (id, convo_id, from_id, text, at, seq, delivered_at) VALUES (?,?,?,?,?,?,?)`,
      ).run(uid('m'), id, botId, text, now - offset, nextSeq(), now - offset);
    });
  };

  dm('u-bot-ava', `Welcome aboard, ${first}! 🎉 I'm Ava from Product. Ping me if you need anything — and try **Settings** for themes and accessibility options.`, 60000);
  dm('u-bot-marcus', 'Hi! IT Helpdesk here. Your account is fully set up. Tip: you can set a quick-unlock PIN under Settings → Account & security.', 45000);

  const groupId = `g-aurora-${userId}`;
  if (!db.prepare('SELECT 1 AS ok FROM conversations WHERE id = ?').get(groupId)) {
    tx(() => {
      db.prepare('INSERT INTO conversations (id, type, title, created_at, created_by) VALUES (?,?,?,?,?)')
        .run(groupId, 'group', 'Project Aurora', now, 'u-bot-leo');
      const m = db.prepare('INSERT OR IGNORE INTO members (convo_id, user_id) VALUES (?,?)');
      for (const id of [userId, 'u-bot-ava', 'u-bot-leo']) m.run(groupId, id);
      db.prepare(
        `INSERT INTO messages (id, convo_id, from_id, text, at, seq, delivered_at) VALUES (?,?,?,?,?,?,?)`,
      ).run(uid('m'), groupId, 'u-bot-leo', 'Design tokens for Aurora are in. Accessibility pass is done — all AA. 🚀', now - 30000, nextSeq(), now - 30000);
    });
  }
}

function replyText(bot, userText) {
  for (const rule of RULES) if (rule.re.test(userText)) return pick(rule.pool);
  return Math.random() < 0.3 ? pick(bot.flavor) : pick(GENERIC);
}

const timers = new Set();
const later = (ms, fn) => {
  const t = setTimeout(() => { timers.delete(t); try { fn(); } catch { /* db closed */ } }, ms);
  timers.add(t);
  t.unref?.();
  return t;
};

export function cancelBotTimers() {
  for (const t of timers) clearTimeout(t);
  timers.clear();
}

/** Called after a human sends a message. Bots in that conversation read it,
    show a typing indicator, then reply. */
export function scheduleBotReply(convoId, msg) {
  const db = handle();
  const botIds = db.prepare(
    `SELECT u.id FROM members m JOIN users u ON u.id = m.user_id
      WHERE m.convo_id = ? AND u.is_bot = 1`,
  ).all(convoId).map((r) => r.id);
  if (!botIds.length || msg.from.startsWith('u-bot-')) return;

  const audience = rt.convoAudience(convoId);

  later(700 + Math.random() * 500, () => {
    const stamp = Date.now();
    const upd = db.prepare(
      `INSERT INTO reads (convo_id, user_id, at) VALUES (?,?,?)
       ON CONFLICT(convo_id, user_id) DO UPDATE SET at = MAX(at, excluded.at)`,
    );
    for (const id of botIds) {
      upd.run(convoId, id, stamp);
      rt.publish(audience, 'read', { convoId, userId: id, at: stamp });
    }
  });

  const convo = db.prepare('SELECT type FROM conversations WHERE id = ?').get(convoId);
  if (convo?.type === 'group' && Math.random() > 0.8) return;

  const responder = BOTS.find((b) => b.id === pick(botIds));
  if (!responder) return;
  const text = replyText(responder, msg.text);
  const typeMs = Math.min(1200 + text.length * 30, 3800);

  later(900, () => rt.publish(audience.filter((u) => u !== responder.id), 'typing',
    { convoId, userId: responder.id, name: responder.name.split(' ')[0] }));

  later(900 + typeMs, () => {
    const now = Date.now();
    const id = uid('m');
    const row = tx(() => {
      db.prepare(
        `INSERT INTO messages (id, convo_id, from_id, text, at, seq, delivered_at) VALUES (?,?,?,?,?,?,?)`,
      ).run(id, convoId, responder.id, text, now, nextSeq(), now);
      db.prepare(
        `INSERT INTO reads (convo_id, user_id, at) VALUES (?,?,?)
         ON CONFLICT(convo_id, user_id) DO UPDATE SET at = MAX(at, excluded.at)`,
      ).run(convoId, responder.id, now);
      return db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
    });
    rt.publish(audience, 'message', { message: shapeMessage(row) });
  });
}

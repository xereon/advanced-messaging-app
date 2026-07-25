// bots.js — simulated colleagues. They read, type and reply with plausible
// workplace chatter so the demo feels alive with a single account.

import { uid } from './util.js';
import {
  allUsers, saveUser, getConvo, saveConvo, ensureDm, appendMessage,
  patchMessage, markRead, messagesOf, toggleReaction, emit, broadcast,
} from './store.js';

export const BOTS = [
  {
    id: 'u-bot-ava', name: 'Ava Chen', role: 'Product Manager', avatarColor: '#7C4DDB',
    flavor: [
      'Roadmap review moved to Thursday, by the way.',
      'I put the latest figures in the shared drive.',
      'Can you take a look before stand-up tomorrow?',
      'The client demo went really well today.',
    ],
  },
  {
    id: 'u-bot-marcus', name: 'Marcus Webb', role: 'IT Helpdesk', avatarColor: '#0E7490',
    flavor: [
      'Have you tried signing out and back in?',
      'Ticket logged — reference #4821.',
      'The VPN maintenance window is Friday 22:00.',
      'Cleared your cache on the profile server, try again now.',
    ],
  },
  {
    id: 'u-bot-priya', name: 'Priya Sharma', role: 'People Ops', avatarColor: '#B0367A',
    flavor: [
      'Reminder: benefits enrolment closes at the end of the month.',
      'The wellbeing workshop had great feedback, thanks for joining!',
      'I have booked the quiet room for your 1:1.',
      'New starters arrive Monday — fancy joining the welcome lunch?',
    ],
  },
  {
    id: 'u-bot-leo', name: 'Leo Fontaine', role: 'Design Lead', avatarColor: '#B45309',
    flavor: [
      'Pushed the new tokens to the design system.',
      'That contrast ratio passes AA now, checked it twice.',
      'Prototype link is in the project channel.',
      'Grid looks tighter with 8px spacing, agreed?',
    ],
  },
];

const RULES = [
  { re: /\b(hi|hey|hello|morning|afternoon)\b/i, pool: [
    'Hey! How is your day going?',
    'Hello! Good timing, I was about to ping you.',
    'Hi there 👋',
  ]},
  { re: /\b(thanks|thank you|cheers|appreciated)\b/i, pool: [
    'Anytime!',
    'No problem at all.',
    'Happy to help 👍',
  ]},
  { re: /\b(meeting|call|standup|stand-up|sync)\b/i, pool: [
    'I can do 2 pm or anytime after 4, your pick.',
    'Calendar invite sent — grab whichever slot works.',
    'Let us keep it to 25 minutes if we can.',
  ]},
  { re: /\b(report|numbers|figures|metrics|quarter|q[1-4])\b/i, pool: [
    'The dashboard refreshed an hour ago, numbers are current.',
    'Headline: up 12% on last quarter. Details in the doc.',
    'I will have the summary ready before end of day.',
  ]},
  { re: /\b(bug|broken|error|crash|issue)\b/i, pool: [
    'Can you send a screenshot? I will raise it now.',
    'Reproduced it on my side too — escalating.',
    'A fix is already in review, should land today.',
  ]},
  { re: /\b(deadline|due|late|schedule|timeline)\b/i, pool: [
    'We are still on track for Friday.',
    'If it slips, better to flag it today rather than Thursday.',
    'I built a day of buffer into the plan, we are fine.',
  ]},
  { re: /\b(lunch|coffee|break)\b/i, pool: [
    'Yes! The usual place at 12:30?',
    'I could definitely use a coffee. 15 minutes?',
    'Count me in 🙂',
  ]},
  { re: /\?$/, pool: [
    'Good question — let me check and come back to you.',
    'Short answer: yes. Long answer on our next call.',
    'I think so, but let me confirm with the team first.',
  ]},
];

const GENERIC = [
  'Got it, thanks for the heads-up.',
  'Makes sense to me.',
  'Understood — I will factor that in.',
  'Noted 👍',
  'Sounds good. Anything you need from me?',
  'Right, that matches what I heard too.',
];

const REACTIONS = ['👍', '💯', '🎉', '👀'];

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

export function seedBots() {
  const users = allUsers();
  for (const bot of BOTS) {
    if (!users[bot.id]) {
      saveUser({ ...bot, isBot: true, email: `${bot.name.split(' ')[0].toLowerCase()}@relay.demo`, createdAt: Date.now() });
    }
  }
}

/** First-run conversations so a fresh account lands in a lived-in workspace. */
export function seedConvosFor(user) {
  const now = Date.now();
  const dm = ensureDm(user.id, 'u-bot-ava');
  if (!messagesOf(dm.id).length) {
    appendMessage(dm.id, {
      id: uid('m'), convoId: dm.id, from: 'u-bot-ava',
      text: `Welcome aboard, ${user.name.split(' ')[0]}! 🎉 I'm Ava from Product. Ping me if you need anything — and try **Settings** for themes and accessibility options.`,
      at: now - 60000, deliveredAt: now - 60000,
    });
  }
  const help = ensureDm(user.id, 'u-bot-marcus');
  if (!messagesOf(help.id).length) {
    appendMessage(help.id, {
      id: uid('m'), convoId: help.id, from: 'u-bot-marcus',
      text: 'Hi! IT Helpdesk here. Your account is fully set up. Tip: you can add a *passkey* or a quick-unlock PIN under Settings → Account & security.',
      at: now - 45000, deliveredAt: now - 45000,
    });
  }
  const groupId = 'g-aurora-' + user.id;
  if (!getConvo(groupId)) {
    saveConvo({ id: groupId, type: 'group', title: 'Project Aurora', members: [user.id, 'u-bot-ava', 'u-bot-leo'], createdAt: now });
    appendMessage(groupId, {
      id: uid('m'), convoId: groupId, from: 'u-bot-leo',
      text: 'Design tokens for Aurora are in. Accessibility pass is done — all AA. 🚀',
      at: now - 30000, deliveredAt: now - 30000,
    });
  }
}

function replyText(bot, userText) {
  for (const rule of RULES) {
    if (rule.re.test(userText)) return pick(rule.pool);
  }
  // 30% of the time, sprinkle in persona flavor instead of a generic ack.
  return Math.random() < 0.3 ? pick(bot.flavor) : pick(GENERIC);
}

const timers = new Set();
function later(ms, fn) {
  const t = setTimeout(() => { timers.delete(t); fn(); }, ms);
  timers.add(t);
}

/** Called after the local user sends a message. Orchestrates delivery, read,
    typing and the reply for any bot in the conversation. */
export function botRespond(convoId, msg, senderId) {
  const convo = getConvo(convoId);
  if (!convo) return;
  const botIds = convo.members.filter((m) => m.startsWith('u-bot-'));
  if (!botIds.length) return;

  // Delivery tick shortly after send.
  later(350 + Math.random() * 300, () => {
    patchMessage(convoId, msg.id, { deliveredAt: Date.now() });
  });

  const responder = allUsers()[pick(botIds)];
  if (!responder) return;
  const willReply = convo.type === 'dm' || Math.random() < 0.8;

  // Bots read soon after delivery (their receipts are always on).
  later(900 + Math.random() * 600, () => {
    for (const b of botIds) markRead(convoId, b);
  });

  if (!willReply) return;

  const text = replyText(responder, msg.text);
  const typeMs = Math.min(1400 + text.length * 35, 4200);

  later(1300 + Math.random() * 700, () => {
    emit('typing', { convoId, userId: responder.id, name: responder.name });
    broadcast('typing', { convoId, userId: responder.id, name: responder.name });
  });

  later(1300 + typeMs, () => {
    appendMessage(convoId, {
      id: uid('m'), convoId, from: responder.id, text,
      at: Date.now(), deliveredAt: Date.now(),
    });
    markRead(convoId, responder.id);
    // Occasionally leave a reaction on the user's message too.
    if (Math.random() < 0.18) {
      later(800, () => toggleReaction(convoId, msg.id, pick(REACTIONS), responder.id));
    }
  });
}

// store.js — persistence (localStorage), data model and cross-tab sync.
//
// Everything lives under the "relay:" namespace:
//   users                 map userId -> user record
//   convos                map convoId -> {id, type:'dm'|'group', members, title?, createdAt}
//   msgs:<convoId>        array of messages
//   reads:<convoId>       map userId -> last-read timestamp
//   cmeta:<userId>        map convoId -> {pinned, muted, draft, clearedBefore}
//   settings:<userId>     per-user settings
//   device                {lastUserId, remember}
//
// Tabs sync through BroadcastChannel (with the storage event as fallback), so
// two tabs signed in as two different accounts can genuinely message each other.

import { uid } from './util.js';

const NS = 'relay:';

export const store = {
  read(key, fallback = null) {
    try {
      const raw = localStorage.getItem(NS + key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch { return fallback; }
  },
  write(key, value) {
    localStorage.setItem(NS + key, JSON.stringify(value));
  },
  remove(key) { localStorage.removeItem(NS + key); },
  allKeys() {
    const out = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith(NS)) out.push(k.slice(NS.length));
    }
    return out;
  },
  usageBytes() {
    let n = 0;
    for (const k of this.allKeys()) n += (localStorage.getItem(NS + k) || '').length * 2;
    return n;
  },
};

/* ---------- Event bus + cross-tab sync ---------- */

export const bus = new EventTarget();
export const emit = (type, detail) => bus.dispatchEvent(new CustomEvent(type, { detail }));
export const on = (type, fn) => bus.addEventListener(type, (e) => fn(e.detail));

const TAB_ID = uid('tab');
let channel = null;
try { channel = new BroadcastChannel('relay-sync'); } catch { /* unsupported */ }

export function broadcast(type, payload = {}) {
  const packet = { type, payload, from: TAB_ID };
  try { channel?.postMessage(packet); } catch { /* closed */ }
}

if (channel) {
  channel.onmessage = (e) => {
    if (e.data?.from === TAB_ID) return;
    emit('remote:' + e.data.type, e.data.payload);
    emit('remote:any', e.data);
  };
}
// Fallback for browsers without BroadcastChannel: storage events.
window.addEventListener('storage', (e) => {
  if (!channel && e.key?.startsWith(NS)) emit('remote:any', { type: 'storage', payload: {} });
});

/* ---------- Users ---------- */

export function allUsers() { return store.read('users', {}); }
export function getUser(id) { return allUsers()[id] || null; }
export function saveUser(user) {
  const users = allUsers();
  users[user.id] = user;
  store.write('users', users);
}
export function deleteUser(id) {
  const users = allUsers();
  delete users[id];
  store.write('users', users);
  store.remove(`cmeta:${id}`);
  store.remove(`settings:${id}`);
}
export function findUserByEmail(email) {
  const needle = String(email).trim().toLowerCase();
  return Object.values(allUsers()).find((u) => u.email === needle) || null;
}

/* ---------- Conversations ---------- */

export function allConvos() { return store.read('convos', {}); }
export function getConvo(id) { return allConvos()[id] || null; }
export function saveConvo(convo) {
  const convos = allConvos();
  convos[convo.id] = convo;
  store.write('convos', convos);
}
export function convosFor(userId) {
  return Object.values(allConvos()).filter((c) => c.members.includes(userId));
}

export function removeConvo(convoId) {
  const convos = allConvos();
  delete convos[convoId];
  store.write('convos', convos);
  store.remove(`msgs:${convoId}`);
  store.remove(`reads:${convoId}`);
}

export function dmId(a, b) { return 'dm:' + [a, b].sort().join('~'); }

export function ensureDm(a, b) {
  const id = dmId(a, b);
  let convo = getConvo(id);
  if (!convo) {
    convo = { id, type: 'dm', members: [a, b].sort(), createdAt: Date.now() };
    saveConvo(convo);
  }
  return convo;
}

export function createGroup(title, members) {
  const convo = { id: uid('g'), type: 'group', title, members: [...new Set(members)], createdAt: Date.now() };
  saveConvo(convo);
  return convo;
}

/* Per-user conversation metadata (pin/mute/draft/cleared). */
export function convoMeta(userId, convoId) {
  const all = store.read(`cmeta:${userId}`, {});
  return all[convoId] || { pinned: false, muted: false, draft: '', clearedBefore: 0 };
}
export function setConvoMeta(userId, convoId, patch) {
  const all = store.read(`cmeta:${userId}`, {});
  all[convoId] = { ...convoMeta(userId, convoId), ...patch };
  store.write(`cmeta:${userId}`, all);
}

/* ---------- Contacts ---------- */

export function contactsOf(userId) { return store.read(`contacts:${userId}`, []); }
export function isContact(userId, otherId) { return contactsOf(userId).includes(otherId); }

export function addContact(userId, otherId) {
  const list = contactsOf(userId);
  if (list.includes(otherId) || userId === otherId) return;
  store.write(`contacts:${userId}`, [...list, otherId]);
  emit('contacts', { userId });
  broadcast('contacts', { userId });
}

export function removeContact(userId, otherId) {
  store.write(`contacts:${userId}`, contactsOf(userId).filter((id) => id !== otherId));
  emit('contacts', { userId });
  broadcast('contacts', { userId });
}

/** Contacts resolved to user records. Ids whose user has been fully deleted
    (e.g. a pruned guest) are dropped from the stored list on the way through. */
export function contactUsers(userId) {
  const list = contactsOf(userId);
  const live = list.filter((id) => getUser(id));
  if (live.length !== list.length) store.write(`contacts:${userId}`, live);
  return live.map((id) => getUser(id));
}

/* ---------- Messages ---------- */

export function messagesOf(convoId) { return store.read(`msgs:${convoId}`, []); }
export function saveMessages(convoId, msgs) { store.write(`msgs:${convoId}`, msgs); }

export function appendMessage(convoId, msg) {
  const msgs = messagesOf(convoId);
  msgs.push(msg);
  saveMessages(convoId, msgs);
  emit('message', { convoId, msg });
  broadcast('message', { convoId, msgId: msg.id });
  return msg;
}

export function patchMessage(convoId, msgId, patch) {
  const msgs = messagesOf(convoId);
  const i = msgs.findIndex((m) => m.id === msgId);
  if (i === -1) return null;
  msgs[i] = { ...msgs[i], ...patch };
  saveMessages(convoId, msgs);
  emit('message-updated', { convoId, msg: msgs[i] });
  broadcast('message-updated', { convoId, msgId });
  return msgs[i];
}

export function toggleReaction(convoId, msgId, emoji, userId) {
  const msgs = messagesOf(convoId);
  const m = msgs.find((x) => x.id === msgId);
  if (!m) return;
  m.reactions = m.reactions || {};
  const list = m.reactions[emoji] || [];
  m.reactions[emoji] = list.includes(userId) ? list.filter((u) => u !== userId) : [...list, userId];
  if (!m.reactions[emoji].length) delete m.reactions[emoji];
  saveMessages(convoId, msgs);
  emit('message-updated', { convoId, msg: m });
  broadcast('message-updated', { convoId, msgId });
}

/* ---------- Read receipts ---------- */

export function readsOf(convoId) { return store.read(`reads:${convoId}`, {}); }

export function markRead(convoId, userId, ts = Date.now()) {
  const reads = readsOf(convoId);
  if ((reads[userId] || 0) >= ts) return;
  reads[userId] = ts;
  store.write(`reads:${convoId}`, reads);
  emit('reads', { convoId });
  broadcast('reads', { convoId });
}

export function unreadCount(convoId, userId, clearedBefore = 0) {
  const lastRead = readsOf(convoId)[userId] || 0;
  return messagesOf(convoId).filter(
    (m) => m.from !== userId && !m.deletedAt && m.at > lastRead && m.at > clearedBefore,
  ).length;
}

/* ---------- Session ---------- */
// Session is per-tab (sessionStorage) so two tabs can hold two accounts.
// "Keep me signed in" additionally records the user on the device.

export function setSession(userId, method, remember) {
  sessionStorage.setItem(NS + 'session', JSON.stringify({ userId, method, at: Date.now() }));
  // Guest sessions are per-tab and ephemeral: they must not overwrite the
  // device's remembered account, or signing in as a guest in one tab would
  // silently sign the real account out of every future tab.
  if (method === 'guest') return;
  const device = store.read('device', {});
  store.write('device', { ...device, lastUserId: userId, remember: !!remember });
}
export function getSession() {
  try { return JSON.parse(sessionStorage.getItem(NS + 'session')); } catch { return null; }
}
export function clearSession() {
  sessionStorage.removeItem(NS + 'session');
  const device = store.read('device', {});
  store.write('device', { ...device, remember: false });
}
export function deviceInfo() { return store.read('device', {}); }

/* ---------- Guest lifecycle ---------- */

/** True if anyone would notice this guest disappearing — i.e. the guest spoke,
    or a real person spoke to them. The seeded bot welcome messages don't count. */
export function guestHasHistory(userId) {
  return convosFor(userId).some((c) => messagesOf(c.id).some(
    (m) => !m.deletedAt && (m.from === userId || !getUser(m.from)?.isBot),
  ));
}

/** Drop a guest and their bot-only conversations, or retire them (keeping the
    profile so their name still renders in other people's history). */
export function releaseGuest(user) {
  if (guestHasHistory(user.id)) {
    saveUser({ ...user, retired: true });
    return 'retired';
  }
  for (const c of convosFor(user.id)) removeConvo(c.id);
  deleteUser(user.id);
  return 'removed';
}

/** Guests whose tab was closed without signing out linger forever. Clear out
    yesterday's abandoned ones so the people directory stays honest. */
export function pruneGuests(exceptId) {
  const cutoff = Date.now() - 86400000;
  for (const u of Object.values(allUsers())) {
    if (!u.isGuest || u.retired || u.id === exceptId || u.createdAt > cutoff) continue;
    releaseGuest(u);
  }
}

/* ---------- Presence (heartbeat over BroadcastChannel) ---------- */

const presence = new Map(); // userId -> lastSeen ts

export function startPresence(userId) {
  const beat = () => broadcast('presence', { userId, at: Date.now() });
  beat();
  const timer = setInterval(beat, 10000);
  window.addEventListener('beforeunload', () => clearInterval(timer));
}
on('remote:presence', ({ userId, at }) => {
  presence.set(userId, at);
  emit('presence-changed', { userId });
});
export function isOnline(user) {
  if (!user) return false;
  if (user.isBot) return true;
  const seen = presence.get(user.id) || 0;
  return Date.now() - seen < 25000;
}

/* ---------- Danger zone ---------- */

export function wipeAll() {
  for (const k of store.allKeys()) store.remove(k);
  sessionStorage.removeItem(NS + 'session');
  broadcast('wipe', {});
}

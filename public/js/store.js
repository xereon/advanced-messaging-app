// store.js — client-side cache over the Relay API.
//
// Reads stay synchronous so the render layer can call them freely; writes go
// to the server and reconcile when it answers or when the SSE stream echoes
// the change back. Event names match what the UI already listens for, so
// rendering does not care whether a change came from this tab, another device,
// or somebody else entirely.

import * as api from './api.js';
import { uid } from './util.js';

/* ---------- event bus ---------- */

const bus = new EventTarget();
export const emit = (type, detail) => bus.dispatchEvent(new CustomEvent(type, { detail }));
export const on = (type, fn) => bus.addEventListener(type, (e) => fn(e.detail));

/* ---------- cache ---------- */

let me = null;
const users = new Map();
const convos = new Map();
const messages = new Map();   // convoId -> Message[]
const reads = new Map();      // convoId -> { userId: ts }
const metas = new Map();      // convoId -> { pinned, muted, draft, clearedBefore }
const contacts = new Set();
const online = new Set();
const hasMore = new Map();    // convoId -> older messages exist on the server
let serverSettings = null;
let stream = null;

export function currentUser() { return me; }
export function initialSettings() { return serverSettings; }

export function hydrate(boot) {
  me = boot.me;
  users.clear(); convos.clear(); messages.clear(); reads.clear(); metas.clear();
  contacts.clear(); online.clear(); hasMore.clear();
  for (const u of boot.users) users.set(u.id, u);
  for (const c of boot.conversations) convos.set(c.id, c);
  for (const [id, list] of Object.entries(boot.messages)) messages.set(id, list);
  for (const [id, more] of Object.entries(boot.hasMore || {})) hasMore.set(id, more);
  for (const [id, map] of Object.entries(boot.reads)) reads.set(id, map);
  for (const [id, m] of Object.entries(boot.meta)) metas.set(id, m);
  for (const id of boot.contacts) contacts.add(id);
  for (const id of boot.online) online.add(id);
  serverSettings = boot.settings;
}

/* ---------- users ---------- */

export function getUser(id) { return users.get(id) || null; }
export function allUsers() { return Object.fromEntries(users); }
export function cacheUser(user) { if (user) users.set(user.id, user); }

export function isOnline(user) {
  if (!user) return false;
  if (user.isBot) return true;
  return online.has(user.id);
}

/* ---------- conversations ---------- */

export function getConvo(id) { return convos.get(id) || null; }
export function allConvos() { return Object.fromEntries(convos); }
export function convosFor() { return [...convos.values()]; }
export function dmId(a, b) { return 'dm:' + [a, b].sort().join('~'); }

function cacheConvo(convo) {
  convos.set(convo.id, convo);
  if (!messages.has(convo.id)) messages.set(convo.id, []);
  if (!reads.has(convo.id)) reads.set(convo.id, {});
  if (!metas.has(convo.id)) metas.set(convo.id, { pinned: false, muted: false, draft: '', clearedBefore: 0 });
}

/** Opens (or creates) the direct conversation with someone. */
export async function ensureDm(_meId, otherId) {
  const known = convos.get(dmId(me.id, otherId));
  if (known) return known;
  const { conversation } = await api.createConversation({ type: 'dm', members: [otherId] });
  cacheConvo(conversation);
  emit('conversations', {});
  return conversation;
}

export async function createGroup(title, members) {
  const { conversation } = await api.createConversation({ type: 'group', title, members: [...members] });
  cacheConvo(conversation);
  emit('conversations', {});
  return conversation;
}

/* ---------- per-user conversation metadata ---------- */

export function convoMeta(_userId, convoId) {
  return metas.get(convoId) || { pinned: false, muted: false, draft: '', clearedBefore: 0 };
}

export function setConvoMeta(_userId, convoId, patch) {
  const next = { ...convoMeta(null, convoId), ...patch };
  metas.set(convoId, next);
  api.setMeta(convoId, patch).catch(() => emit('error', { message: 'Could not save that change.' }));
  return next;
}

/* ---------- messages ---------- */

export function messagesOf(convoId) { return messages.get(convoId) || []; }

export function hasOlder(convoId) { return !!hasMore.get(convoId); }

/** Prepend a page of older messages. Returns how many arrived. */
export async function loadOlder(convoId) {
  const list = messages.get(convoId) || [];
  const oldest = list.find((m) => typeof m.seq === 'number');
  if (!oldest) return 0;
  const { messages: page, hasMore: more } = await api.olderMessages(convoId, oldest.seq);
  const known = new Set(list.map((m) => m.id));
  const fresh = page.filter((m) => !known.has(m.id));
  messages.set(convoId, [...fresh, ...list]);
  hasMore.set(convoId, more);
  emit('history', { convoId, added: fresh.length });
  return fresh.length;
}

function upsertMessage(msg, clientId) {
  const list = messages.get(msg.convoId) || [];
  // Reconcile an optimistic row first, then fall back to matching by id.
  let i = clientId ? list.findIndex((m) => m.id === clientId) : -1;
  if (i === -1) i = list.findIndex((m) => m.id === msg.id);
  if (i === -1) {
    list.push(msg);
    list.sort((a, b) => a.at - b.at || (a.seq ?? 0) - (b.seq ?? 0));
  } else {
    list[i] = { ...list[i], ...msg, pending: false, failed: false };
  }
  messages.set(msg.convoId, list);
  return msg;
}

/** Optimistically shows the message, then sends it. */
export async function appendMessage(convoId, draft) {
  const clientId = uid('pending');
  const optimistic = {
    id: clientId, convoId, from: me.id, text: draft.text,
    at: Date.now(), replyTo: draft.replyTo, reactions: {}, pending: true,
    attachments: draft.attachments || [],
  };
  const list = messages.get(convoId) || [];
  list.push(optimistic);
  messages.set(convoId, list);
  emit('message', { convoId, msg: optimistic });

  try {
    const { message } = await api.sendMessage(convoId, {
      text: draft.text, replyTo: draft.replyTo, clientId,
      attachmentIds: (draft.attachments || []).map((a) => a.id),
    });
    upsertMessage(message, clientId);
    emit('message-updated', { convoId, msg: message });
    return message;
  } catch (err) {
    const idx = list.findIndex((m) => m.id === clientId);
    if (idx !== -1) {
      list[idx] = { ...list[idx], pending: false, failed: true };
      emit('message-updated', { convoId, msg: list[idx] });
    }
    emit('error', { message: err.message });
    throw err;
  }
}

export async function patchMessage(convoId, msgId, patch) {
  try {
    const { message } = patch.deletedAt
      ? await api.deleteMessage(msgId)
      : await api.editMessage(msgId, patch.text);
    upsertMessage(message);
    emit('message-updated', { convoId, msg: message });
    return message;
  } catch (err) {
    emit('error', { message: err.message });
    return null;
  }
}

export async function toggleReaction(convoId, msgId, emoji) {
  try {
    const { message } = await api.react(msgId, emoji);
    upsertMessage(message);
    emit('message-updated', { convoId, msg: message });
  } catch (err) {
    emit('error', { message: err.message });
  }
}

/* ---------- reads ---------- */

export function readsOf(convoId) { return reads.get(convoId) || {}; }

let receiptsEnabled = true;
export function setReceiptsEnabled(value) { receiptsEnabled = !!value; }

export function markRead(convoId, _userId, ts = Date.now()) {
  const map = reads.get(convoId) || {};
  if ((map[me.id] || 0) >= ts) return;
  map[me.id] = ts;
  reads.set(convoId, map);
  emit('reads', { convoId });
  api.markRead(convoId, ts, !receiptsEnabled).catch(() => { /* retried on next read */ });
}

export function unreadCount(convoId, _userId, clearedBefore = 0) {
  const lastRead = readsOf(convoId)[me.id] || 0;
  return messagesOf(convoId).filter(
    (m) => m.from !== me.id && !m.deletedAt && m.at > lastRead && m.at > clearedBefore,
  ).length;
}

/* ---------- contacts ---------- */

export function contactsOf() { return [...contacts]; }
export function isContact(_userId, otherId) { return contacts.has(otherId); }

export function addContact(_userId, otherId) {
  contacts.add(otherId);
  emit('contacts', { userId: me.id });
  api.addContact(otherId).catch((err) => {
    contacts.delete(otherId);
    emit('contacts', { userId: me.id });
    emit('error', { message: err.message });
  });
}

export function removeContact(_userId, otherId) {
  contacts.delete(otherId);
  emit('contacts', { userId: me.id });
  api.removeContact(otherId).catch((err) => {
    contacts.add(otherId);
    emit('contacts', { userId: me.id });
    emit('error', { message: err.message });
  });
}

export function contactUsers() {
  return [...contacts].map((id) => users.get(id)).filter(Boolean);
}

/* ---------- account ---------- */

export async function updateProfile(patch) {
  const { user } = await api.updateProfile(patch);
  me = user;
  cacheUser(user);
  return user;
}

export async function signOut() {
  disconnect();
  await api.logout();
}

export async function deleteAccount() {
  disconnect();
  await api.deleteAccount();
}

export const saveSettings = (settings) => api.saveSettings(settings);
export const passkeysSupported = api.passkeysSupported;
export const registerPasskey = (label) => api.registerPasskey(label);
export const listPasskeys = () => api.listPasskeys();
export const deletePasskey = (id) => api.deletePasskey(id);
export const uploadAttachment = (convoId, file, opts) => api.uploadAttachment(convoId, file, opts);
export const setPin = (pin) => api.setPin(pin);
export const changePassword = (current, next) => api.changePassword(current, next);
export const exportData = () => api.exportData();
export const searchDirectory = (q) => api.searchUsers(q);

/* ---------- typing ---------- */

export function sendTyping(convoId) {
  api.sendTyping(convoId).catch(() => { /* best effort */ });
}

/* ---------- live stream ---------- */

export function connect() {
  stream?.close();
  stream = api.openStream({
    message: ({ message, clientId }) => {
      // A message for a conversation we have never seen means our snapshot is
      // behind; pull a fresh one rather than dropping it.
      if (!convos.has(message.convoId)) { resync().catch(() => {}); return; }
      const existing = messagesOf(message.convoId).some((m) => m.id === message.id);
      upsertMessage(message, clientId);
      if (existing) emit('message-updated', { convoId: message.convoId, msg: message });
      else emit('message', { convoId: message.convoId, msg: message });
    },
    'message-updated': ({ message }) => {
      upsertMessage(message);
      emit('message-updated', { convoId: message.convoId, msg: message });
    },
    read: ({ convoId, userId, at }) => {
      const map = reads.get(convoId) || {};
      if ((map[userId] || 0) >= at) return;
      map[userId] = at;
      reads.set(convoId, map);
      emit('reads', { convoId });
    },
    typing: ({ convoId, userId, name }) => emit('typing', { convoId, userId, name }),
    presence: ({ userId, online: isUp }) => {
      if (isUp) online.add(userId); else online.delete(userId);
      emit('presence-changed', { userId });
    },
    conversation: ({ conversation, users: people }) => {
      for (const u of people || []) cacheUser(u);
      cacheConvo(conversation);
      emit('conversations', {});
    },
    user: ({ user }) => { cacheUser(user); emit('users', { user }); },
    contacts: ({ contacts: list }) => {
      contacts.clear();
      for (const id of list) contacts.add(id);
      emit('contacts', { userId: me.id });
    },
  }, {
    onStatus: (status) => emit('connection', { status }),
  });
}

export function disconnect() { stream?.close(); stream = null; }

/** Pull a fresh snapshot. The SSE backlog is bounded, so a long outage can
    outrun it and a full resync is the safe way back. */
export async function resync() {
  hydrate(await api.bootstrap());
  emit('resynced', {});
}

/* ---------- device preferences (this browser, not account data) ---------- */

const DEVICE_KEY = 'relay:device';

export function deviceInfo() {
  try { return JSON.parse(localStorage.getItem(DEVICE_KEY)) || {}; } catch { return {}; }
}

export function rememberDevice(patch) {
  try { localStorage.setItem(DEVICE_KEY, JSON.stringify({ ...deviceInfo(), ...patch })); }
  catch { /* private mode */ }
}

export function forgetDevice() {
  try { localStorage.removeItem(DEVICE_KEY); } catch { /* private mode */ }
}

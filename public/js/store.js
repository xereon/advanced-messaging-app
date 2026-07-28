// store.js — client-side cache over the Relay API.
//
// Reads stay synchronous so the render layer can call them freely; writes go
// to the server and reconcile when it answers or when the SSE stream echoes
// the change back. Event names match what the UI already listens for, so
// rendering does not care whether a change came from this tab, another device,
// or somebody else entirely.

import * as api from './api.js';
import * as outbox from './outbox.js';
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
  blocked.clear();
  for (const id of boot.blocked || []) blocked.add(id);
  for (const id of boot.online) online.add(id);
  serverSettings = boot.settings;

  // Anything the outbox is still holding belongs in the timeline, marked as
  // waiting, so a reload does not appear to have swallowed it.
  for (const entry of outbox.pending(me.id)) {
    const list = messages.get(entry.convoId);
    if (!list || list.some((m) => m.id === entry.clientId)) continue;
    list.push({
      id: entry.clientId, convoId: entry.convoId, from: me.id, text: entry.text,
      at: entry.queuedAt, replyTo: entry.replyTo, reactions: {}, pending: true, queued: true,
    });
  }
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

/**
 * Insert or update a message.
 *
 * Returns `replacedId` when this message took the place of an optimistic row.
 * Callers need that: the rendered bubble still carries the temporary id, so it
 * has to be replaced in place. Treating it as a fresh arrival would append a
 * second bubble and leave the pending one behind — the message would look like
 * it had been sent twice.
 */
function upsertMessage(msg, clientId) {
  const list = messages.get(msg.convoId) || [];
  let replacedId = null;

  // Reconcile an optimistic row first, then fall back to matching by id.
  let i = clientId ? list.findIndex((m) => m.id === clientId) : -1;
  if (i !== -1) replacedId = clientId;
  if (i === -1) i = list.findIndex((m) => m.id === msg.id);

  if (i === -1) {
    list.push(msg);
    list.sort((a, b) => a.at - b.at || (a.seq ?? 0) - (b.seq ?? 0));
  } else {
    // Clear every provisional flag: a confirmed message is not pending, not
    // queued and not failed, whatever it was a moment ago.
    list[i] = { ...list[i], ...msg, pending: false, queued: false, failed: false };
  }
  messages.set(msg.convoId, list);
  return { msg, replacedId };
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
    const { replacedId } = upsertMessage(message, clientId);
    emit('message-updated', { convoId, msg: message, previousId: replacedId });
    return message;
  } catch (err) {
    const idx = list.findIndex((m) => m.id === clientId);
    // A refusal is final; anything else is worth retrying when we reconnect.
    const permanent = err?.status >= 400 && err.status < 500;
    if (!permanent) {
      outbox.add({
        userId: me.id, clientId, convoId,
        text: draft.text, replyTo: draft.replyTo,
        attachmentIds: (draft.attachments || []).map((a) => a.id),
      });
    }
    if (idx !== -1) {
      list[idx] = { ...list[idx], pending: !permanent, failed: permanent, queued: !permanent };
      emit('message-updated', { convoId, msg: list[idx] });
    }
    emit(permanent ? 'error' : 'queued', {
      message: permanent ? err.message : 'No connection — this will send when you are back online.',
      count: outbox.count(me.id),
    });
    if (permanent) throw err;
    return null;
  }
}

/**
 * Send everything the outbox is holding. Safe to call repeatedly.
 *
 * Two things ask for a flush when the network returns — the browser's `online`
 * event and the event stream reconnecting — and they can arrive together. Both
 * would read the same queue and send every entry twice, so a flush already in
 * progress is joined rather than started again.
 */
let flushing = null;

export async function flushOutbox() {
  if (!me) return 0;
  if (flushing) return flushing;
  flushing = doFlush().finally(() => { flushing = null; });
  return flushing;
}

async function doFlush() {
  return outbox.flush(
    me.id,
    async (entry) => {
      const { message } = await api.sendMessage(entry.convoId, {
        text: entry.text, replyTo: entry.replyTo,
        clientId: entry.clientId, attachmentIds: entry.attachmentIds,
      });
      const { replacedId } = upsertMessage(message, entry.clientId);
      emit('message-updated', { convoId: entry.convoId, msg: message, previousId: replacedId });
      return message;
    },
    {
      onGivenUp: (entry, err) => {
        const list = messages.get(entry.convoId) || [];
        const i = list.findIndex((m) => m.id === entry.clientId);
        if (i !== -1) {
          list[i] = { ...list[i], pending: false, queued: false, failed: true };
          emit('message-updated', { convoId: entry.convoId, msg: list[i] });
        }
        emit('error', { message: err?.message || 'A message could not be sent.' });
      },
    },
  ).then((sent) => {
    if (sent) emit('outbox', { sent, remaining: outbox.count(me.id) });
    return sent;
  });
}

export const outboxCount = () => (me ? outbox.count(me.id) : 0);

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
export const searchMessages = (q) => api.searchMessages(q);

/* ---------- blocking ---------- */

const blocked = new Set();

export const blockedIds = () => [...blocked];
export const isBlocked = (userId) => blocked.has(userId);

export async function blockUser(userId) {
  const { blocked: list } = await api.blockUser(userId);
  blocked.clear();
  for (const id of list) blocked.add(id);
  // Blocking changes what exists: conversations and history both shift.
  await resync();
  emit('blocks', { blocked: [...blocked] });
}

export async function unblockUser(userId) {
  const { blocked: list } = await api.unblockUser(userId);
  blocked.clear();
  for (const id of list) blocked.add(id);
  await resync();
  emit('blocks', { blocked: [...blocked] });
}

export const blockedUsers = () => api.blockedUsers();
export const submitReport = (payload) => api.submitReport(payload);

/* ---------- push notifications ---------- */

const urlBase64ToUint8Array = (base64) => {
  const padded = base64.replace(/-/g, '+').replace(/_/g, '/')
    + '='.repeat((4 - (base64.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
};

export const pushSupported = () => !!(
  'serviceWorker' in navigator && 'PushManager' in window && window.isSecureContext
);

/** Register this device for notifications that arrive with the app closed. */
export async function enablePush() {
  if (!pushSupported()) throw new Error('This browser cannot receive push notifications.');
  const registration = await navigator.serviceWorker.ready;

  let subscription = await registration.pushManager.getSubscription();
  if (!subscription) {
    const { publicKey } = await api.pushKey();
    subscription = await registration.pushManager.subscribe({
      // Push services require every message to be attributable and encrypted.
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });
  }
  await api.pushSubscribe(subscription.toJSON());
  return true;
}

export async function disablePush() {
  if (!pushSupported()) return;
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  if (!subscription) return;
  // Tell the server first, so it stops sending even if unsubscribing fails.
  await api.pushUnsubscribe(subscription.endpoint).catch(() => {});
  await subscription.unsubscribe().catch(() => {});
}

export async function pushEnabled() {
  if (!pushSupported()) return false;
  try {
    const registration = await navigator.serviceWorker.ready;
    return !!(await registration.pushManager.getSubscription());
  } catch { return false; }
}
export const requestReset = (email) => api.requestReset(email);
export const confirmReset = (email, code, password) => api.confirmReset(email, code, password);

export async function renameGroup(convoId, title) {
  const { conversation } = await api.renameGroup(convoId, title);
  cacheConvo(conversation);
  emit('conversations', {});
  return conversation;
}

export async function addMember(convoId, userId) {
  const { conversation } = await api.addMember(convoId, userId);
  cacheConvo(conversation);
  emit('conversations', {});
  return conversation;
}

export async function removeMember(convoId, userId) {
  const res = await api.removeMember(convoId, userId);
  emit('conversations', {});
  return res;
}

/** Total unread across every conversation — drives the tab title badge. */
export function totalUnread() {
  if (!me) return 0;
  let n = 0;
  for (const convo of convos.values()) {
    const meta = metas.get(convo.id);
    if (meta?.muted) continue;
    n += unreadCount(convo.id, me.id, meta?.clearedBefore || 0);
  }
  return n;
}

export async function fetchProfile(userId) {
  const profile = await api.getProfile(userId);
  cacheUser(profile.user);          // keeps names and colours fresh everywhere
  return profile;
}

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
      const { replacedId } = upsertMessage(message, clientId);
      // The echo can outrun the send's own response. When it does it is still
      // our pending message coming home, not a new one.
      if (existing || replacedId) {
        emit('message-updated', { convoId: message.convoId, msg: message, previousId: replacedId });
      } else {
        emit('message', { convoId: message.convoId, msg: message });
      }
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
    blocks: ({ blocked: list }) => {
      blocked.clear();
      for (const id of list) blocked.add(id);
      emit('blocks', { blocked: list });
    },
    // Sent to the person on the other side of a block. Deliberately says
    // nothing about what changed.
    refresh: () => { resync().catch(() => {}); },
    'conversation-removed': ({ convoId }) => {
      convos.delete(convoId);
      messages.delete(convoId);
      reads.delete(convoId);
      metas.delete(convoId);
      emit('conversation-removed', { convoId });
    },
    contacts: ({ contacts: list }) => {
      contacts.clear();
      for (const id of list) contacts.add(id);
      emit('contacts', { userId: me.id });
    },
  }, {
    onStatus: (status) => {
      emit('connection', { status });
      if (status === 'online') flushOutbox().catch(() => {});
    },
  });
}

export function disconnect() { stream?.close(); stream = null; }

/** The browser's own online signal is a second, earlier hint than the stream. */
export function watchConnectivity() {
  window.addEventListener('online', () => flushOutbox().catch(() => {}));
}

/**
 * Reconcile presence with the server.
 *
 * A pushed presence event only reaches clients held by the same worker process,
 * and a multi-worker host (Passenger, or several instances) has many. Polling
 * is what makes presence correct regardless — and it keeps working even if the
 * host buffers the event stream entirely.
 */
let presenceTimer = null;
const PRESENCE_POLL_MS = 30_000;

export async function refreshPresence() {
  try {
    const { online: ids } = await api.presence();
    const next = new Set(ids);
    // Only announce the accounts whose state actually moved.
    const changed = [];
    for (const id of next) if (!online.has(id)) changed.push(id);
    for (const id of online) if (!next.has(id)) changed.push(id);
    online.clear();
    for (const id of next) online.add(id);
    if (changed.length) emit('presence-changed', { userIds: changed });
    return changed.length;
  } catch {
    return 0;   // offline; keep the last known state
  }
}

export function watchPresence() {
  clearInterval(presenceTimer);
  presenceTimer = setInterval(() => refreshPresence(), PRESENCE_POLL_MS);
  // Coming back to the tab is exactly when a stale indicator is most obvious.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refreshPresence();
  });
  refreshPresence();
}

export function stopWatchingPresence() { clearInterval(presenceTimer); presenceTimer = null; }

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

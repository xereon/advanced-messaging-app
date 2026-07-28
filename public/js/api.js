// api.js — thin client for the Relay HTTP API.
// The session lives in an httpOnly cookie, so nothing here handles tokens.

export class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function request(method, path, body) {
  const init = {
    method,
    credentials: 'same-origin',
    headers: { 'X-Relay-Client': '1' },
  };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(`/api${path}`, init);
  } catch {
    throw new ApiError(0, 'Cannot reach the server. Check your connection.');
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new ApiError(res.status, data.error || `Request failed (${res.status}).`);
  return data;
}

export const get = (path) => request('GET', path);
export const post = (path, body) => request('POST', path, body ?? {});
export const patch = (path, body) => request('PATCH', path, body ?? {});
export const put = (path, body) => request('PUT', path, body ?? {});
export const del = (path, body) => request('DELETE', path, body);

/* ---------- auth ---------- */

export const signup = (name, email, password) => post('/auth/signup', { name, email, password });
export const login = (email, password) => post('/auth/login', { email, password });
export const guest = () => post('/auth/guest');
export const requestCode = (email) => post('/auth/code/request', { email });
export const verifyCode = (email, code) => post('/auth/code/verify', { email, code });
export const pinLogin = (userId, pin) => post('/auth/pin', { userId, pin });
export const logout = () => post('/auth/logout');
export const me = () => get('/me');

/* ---------- data ---------- */

export const bootstrap = () => get('/bootstrap');
export const presence = () => get('/presence');
export const pushKey = () => get('/push/key');
export const pushSubscribe = (subscription) => post('/push/subscribe', subscription);
export const pushUnsubscribe = (endpoint) => del('/push/subscribe', { endpoint });
export const searchUsers = (q) => get(`/users?q=${encodeURIComponent(q || '')}`);
export const getProfile = (userId) => get(`/users/${encodeURIComponent(userId)}`);
export const requestReset = (email) => post('/auth/reset/request', { email });
export const confirmReset = (email, code, password) => post('/auth/reset/confirm', { email, code, password });
export const renameGroup = (convoId, title) => patch(`/conversations/${encodeURIComponent(convoId)}`, { title });
export const addMember = (convoId, userId) => post(`/conversations/${encodeURIComponent(convoId)}/members`, { userId });
export const removeMember = (convoId, userId) =>
  del(`/conversations/${encodeURIComponent(convoId)}/members/${encodeURIComponent(userId)}`);
export const searchMessages = (q, limit = 40) =>
  get(`/search/messages?q=${encodeURIComponent(q)}&limit=${limit}`);
export const createConversation = (payload) => post('/conversations', payload);
export const sendMessage = (convoId, payload) => post(`/conversations/${encodeURIComponent(convoId)}/messages`, payload);
export const editMessage = (msgId, text) => patch(`/messages/${encodeURIComponent(msgId)}`, { text });
export const deleteMessage = (msgId) => del(`/messages/${encodeURIComponent(msgId)}`);
export const react = (msgId, emoji) => post(`/messages/${encodeURIComponent(msgId)}/reactions`, { emoji });
export const markRead = (convoId, at, isPrivate) => post(`/conversations/${encodeURIComponent(convoId)}/read`, { at, private: !!isPrivate });
export const setMeta = (convoId, meta) => patch(`/conversations/${encodeURIComponent(convoId)}/meta`, meta);
export const sendTyping = (convoId) => post(`/conversations/${encodeURIComponent(convoId)}/typing`);
export const addContact = (contactId) => post('/contacts', { contactId });
export const removeContact = (contactId) => del(`/contacts/${encodeURIComponent(contactId)}`);
export const updateProfile = (payload) => patch('/profile', payload);
export const saveSettings = (settings) => put('/settings', { settings });
export const setPin = (pin) => post('/account/pin', { pin });
export const changePassword = (current, next) => post('/account/password', { current, next });
export const deleteAccount = () => del('/account');
export const exportData = () => get('/export');

/* ---------- passkeys ---------- */

const b64urlToBuf = (s) => Uint8Array.from(atob(String(s).replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const bufToB64url = (b) => btoa(String.fromCharCode(...new Uint8Array(b)))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export const passkeysSupported = () => !!(
  window.PublicKeyCredential && navigator.credentials?.create && window.isSecureContext
);

export async function registerPasskey(label) {
  const options = await post('/auth/passkey/register/options');
  const credential = await navigator.credentials.create({
    publicKey: {
      ...options,
      challenge: b64urlToBuf(options.challenge),
      user: { ...options.user, id: b64urlToBuf(options.user.id) },
      excludeCredentials: (options.excludeCredentials || []).map((c) => ({ ...c, id: b64urlToBuf(c.id) })),
    },
  });
  if (!credential) throw new ApiError(0, 'No passkey was created.');
  return post('/auth/passkey/register/verify', {
    challenge: options.challenge,
    label,
    clientDataJSON: bufToB64url(credential.response.clientDataJSON),
    attestationObject: bufToB64url(credential.response.attestationObject),
  });
}

export async function passkeySignIn() {
  const options = await post('/auth/passkey/login/options');
  const assertion = await navigator.credentials.get({
    publicKey: {
      ...options,
      challenge: b64urlToBuf(options.challenge),
      allowCredentials: (options.allowCredentials || []).map((c) => ({ ...c, id: b64urlToBuf(c.id) })),
    },
    mediation: 'optional',
  });
  if (!assertion) throw new ApiError(0, 'No passkey was offered.');
  return post('/auth/passkey/login/verify', {
    challenge: options.challenge,
    credentialId: bufToB64url(assertion.rawId),
    clientDataJSON: bufToB64url(assertion.response.clientDataJSON),
    authenticatorData: bufToB64url(assertion.response.authenticatorData),
    signature: bufToB64url(assertion.response.signature),
  });
}

export const listPasskeys = () => get('/account/passkeys');
export const deletePasskey = (id) => del(`/account/passkeys/${encodeURIComponent(id)}`);

/* ---------- history & attachments ---------- */

export const olderMessages = (convoId, beforeSeq, limit = 50) =>
  get(`/conversations/${encodeURIComponent(convoId)}/messages?before=${beforeSeq}&limit=${limit}`);

const THUMB_MAX_EDGE = 1280;
const THUMB_MIN_SAVING = 0.85;   // not worth re-encoding for a token gain

/**
 * Downscale an oversized photo before it is uploaded.
 *
 * A phone camera produces several megabytes that every recipient then has to
 * download to look at a chat bubble. Re-encoding in the browser avoids needing
 * an image library on the server, and keeps the original aspect ratio. If
 * anything about it fails — an unsupported codec, no canvas — the original file
 * is uploaded unchanged.
 */
export async function shrinkImage(file) {
  if (!/^image\/(png|jpeg|webp)$/.test(file.type)) return file;
  if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas !== 'function') return file;

  try {
    const bitmap = await createImageBitmap(file);
    const longest = Math.max(bitmap.width, bitmap.height);
    if (longest <= THUMB_MAX_EDGE) { bitmap.close?.(); return file; }

    const scale = THUMB_MAX_EDGE / longest;
    const width = Math.round(bitmap.width * scale);
    const height = Math.round(bitmap.height * scale);
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0, width, height);
    bitmap.close?.();

    // Keep PNG for PNG (transparency); otherwise JPEG is far smaller.
    const type = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
    const blob = await canvas.convertToBlob({ type, quality: 0.82 });
    if (!blob || blob.size > file.size * THUMB_MIN_SAVING) return file;

    return new File([blob], file.name, { type: blob.type, lastModified: file.lastModified });
  } catch {
    return file;   // never block an upload over a resize
  }
}

/** Uploads the raw file; the name and type ride in headers. */
export async function uploadAttachment(convoId, original, { onProgress } = {}) {
  const file = await shrinkImage(original);
  const res = await fetch(`/api/conversations/${encodeURIComponent(convoId)}/attachments`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'X-Relay-Client': '1',
      'X-Relay-Filename': encodeURIComponent(file.name || 'file'),
      'Content-Type': file.type || 'application/octet-stream',
    },
    body: file,
    duplex: 'half',
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new ApiError(res.status, data.error || 'Upload failed.');
  onProgress?.(1);
  return data.attachment;
}

/* ---------- live stream ---------- */

/** Opens the SSE stream. EventSource reconnects by itself and replays missed
    events via Last-Event-ID, so callers only supply handlers. */
export function openStream(handlers, { onStatus } = {}) {
  let source = null;
  let closed = false;

  const connect = () => {
    if (closed) return;
    source = new EventSource('/api/events', { withCredentials: true });
    source.onopen = () => onStatus?.('online');
    source.onerror = () => {
      onStatus?.('reconnecting');
      // EventSource retries on its own unless the stream was closed outright.
      if (source.readyState === EventSource.CLOSED && !closed) {
        setTimeout(connect, 2000);
      }
    };
    for (const [type, fn] of Object.entries(handlers)) {
      source.addEventListener(type, (e) => {
        try { fn(JSON.parse(e.data)); } catch { /* malformed frame */ }
      });
    }
  };

  connect();
  return { close() { closed = true; source?.close(); } };
}

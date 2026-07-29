// util.js — small shared helpers, no state.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function uid(prefix = 'id') {
  if (crypto.randomUUID) return `${prefix}-${crypto.randomUUID()}`;
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

export function esc(str) {
  return String(str)
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

const URL_RE = /\bhttps?:\/\/[^\s<>"')\]]+/g;

const MENTION_RE = /(^|[\s(])@([a-z0-9_]{3,20})\b/gi;

/**
 * Escape, then apply **bold** / *italic* / `code`, links and @mentions.
 *
 * `mentions` maps a lowercased handle to a display name. Only handles in that
 * map are marked up, so an @ in ordinary prose stays ordinary text rather than
 * every address-like word lighting up. `me` gets a stronger treatment, because
 * "somebody was mentioned" and "you were mentioned" are different news.
 */
export function renderRich(text, { mentions = null, meHandle = null } = {}) {
  let html = esc(text);
  html = html.replace(URL_RE, (m) => `<a href="${m}" target="_blank" rel="noopener noreferrer">${m}</a>`);
  html = html.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  html = html.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/(^|[\s(])\*([^*\n]+)\*(?=$|[\s).,!?])/g, '$1<em>$2</em>');

  if (mentions && mentions.size) {
    html = html.replace(MENTION_RE, (whole, lead, handle) => {
      const key = handle.toLowerCase();
      if (!mentions.has(key)) return whole;
      const cls = key === meHandle ? 'mention mention-me' : 'mention';
      // The handle is already escaped by esc() above; the class is ours.
      return `${lead}<span class="${cls}">@${handle}</span>`;
    });
  }
  return html;
}

/** Which handles in this text belong to people who can actually see it. */
export function mentionedHandles(text, handles) {
  const found = new Set();
  for (const m of String(text || '').matchAll(MENTION_RE)) {
    const key = m[2].toLowerCase();
    if (handles.has(key)) found.add(key);
  }
  return found;
}

export function initials(name) {
  const parts = String(name)
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .trim().split(/\s+/).filter(Boolean).slice(0, 2);
  return parts.map((p) => p[0].toUpperCase()).join('') || '?';
}

export function fmtTime(ts, use24h) {
  return new Date(ts).toLocaleTimeString([], {
    hour: 'numeric', minute: '2-digit', hour12: !use24h,
  });
}

export function fmtDay(ts) {
  const d = new Date(ts);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const day = new Date(d); day.setHours(0, 0, 0, 0);
  const diff = Math.round((today - day) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  if (diff < 7) return d.toLocaleDateString([], { weekday: 'long' });
  return d.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
}

/** Compact time for the sidebar: 14:32 today, "Tue" this week, "12 Jun" older. */
export function fmtCompact(ts, use24h) {
  const d = new Date(ts);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const day = new Date(d); day.setHours(0, 0, 0, 0);
  const diff = Math.round((today - day) / 86400000);
  if (diff === 0) return fmtTime(ts, use24h);
  if (diff < 7) return d.toLocaleDateString([], { weekday: 'short' });
  return d.toLocaleDateString([], { day: 'numeric', month: 'short' });
}

export function downloadFile(name, mime, content) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// settings.js — per-user settings: schema, theme registry, persistence and
// applying everything to the document. UI wiring lives in ui.js.

import { saveSettings as pushSettings } from './store.js';
import { debounce } from './util.js';

export const DEFAULTS = {
  theme: 'auto',            // 'auto' follows the OS light/dark preference
  fontScale: 100,           // %
  lineHeight: 1.5,
  letterSpacing: 0,         // em
  fontFamily: 'system',
  density: 'cozy',
  boldText: false,

  reduceMotion: false,
  reduceTransparency: false,
  underlineLinks: false,
  strongFocus: false,
  largeTargets: false,
  alwaysTimestamps: false,
  announceMessages: true,
  shortcutsEnabled: true,

  enterToSend: true,
  readReceipts: true,
  typingIndicators: true,
  use24h: false,
  sounds: true,
  desktopNotifs: false,
};

// Swatches are illustrative only — the real colours come from CSS.
export const THEMES = [
  { id: 'auto', name: 'Match system', tag: 'Follows OS light/dark', swatches: ['#f2f4f9', '#0e1320', '#2458e6'] },
  { id: 'light', name: 'Corporate Light', tag: 'Default', swatches: ['#f2f4f9', '#ffffff', '#2458e6'] },
  { id: 'dark', name: 'Corporate Dark', tag: 'Low light', swatches: ['#0e1320', '#161d2e', '#5f8dff'] },
  { id: 'slate', name: 'Midnight Slate', tag: 'Dim, teal accent', swatches: ['#171c22', '#1f262e', '#55b3c9'] },
  { id: 'contrast-light', name: 'High Contrast Light', tag: 'Maximum legibility', swatches: ['#ffffff', '#000000', '#0026cc'] },
  { id: 'contrast-dark', name: 'High Contrast Dark', tag: 'Maximum legibility', swatches: ['#000000', '#ffffff', '#ffd500'] },
  { id: 'deuteranopia', name: 'Deuteranopia', tag: 'Red–green safe · blue/orange', swatches: ['#f2f4f9', '#0072b2', '#b34c00'] },
  { id: 'protanopia', name: 'Protanopia', tag: 'Red–green safe · blue/amber', swatches: ['#f2f4f9', '#005fa8', '#9a5d00'] },
  { id: 'tritanopia', name: 'Tritanopia', tag: 'Blue–yellow safe · magenta/green', swatches: ['#f2f4f9', '#a82865', '#1d7a34'] },
  { id: 'mono', name: 'Monochrome', tag: 'No colour cues at all', swatches: ['#f4f4f4', '#262626', '#8f8f8f'] },
];

const prefersDark = window.matchMedia('(prefers-color-scheme: dark)');
const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

let current = { ...DEFAULTS };
let currentUserId = null;

const LOCAL_KEY = (id) => `relay:settings:${id}`;

// Settings live on the account so they follow you between devices. A copy is
// kept in this browser too, purely so the sign-in screen can paint the right
// theme before the server has answered.
const push = debounce(() => {
  pushSettings(current).catch(() => { /* retried on the next change */ });
}, 400);

function cacheLocally() {
  try { localStorage.setItem(LOCAL_KEY(currentUserId), JSON.stringify(current)); }
  catch { /* private mode */ }
}

export function loadSettings(userId, fromServer) {
  currentUserId = userId;
  let local = {};
  try { local = JSON.parse(localStorage.getItem(LOCAL_KEY(userId))) || {}; } catch { /* ignore */ }
  current = { ...DEFAULTS, ...local, ...(fromServer || {}) };
  cacheLocally();
  return current;
}

/** Paint the last-used theme on the sign-in screen, before any account is known. */
export function loadCachedSettings(userId) {
  if (!userId) return current;
  try { current = { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(LOCAL_KEY(userId))) || {}) }; }
  catch { /* ignore */ }
  return current;
}

export function getSettings() { return current; }

export function setSetting(key, value) {
  current[key] = value;
  if (currentUserId) { cacheLocally(); push(); }
  applySettings();
}

export function resetSettings() {
  current = { ...DEFAULTS };
  if (currentUserId) { cacheLocally(); push(); }
  applySettings();
}

export function resolvedTheme() {
  if (current.theme !== 'auto') return current.theme;
  return prefersDark.matches ? 'dark' : 'light';
}

export function applySettings() {
  const root = document.documentElement;
  const s = current;
  root.dataset.theme = resolvedTheme();
  root.dataset.font = s.fontFamily;
  root.dataset.density = s.density;
  root.style.setProperty('--font-scale', s.fontScale / 100);
  root.style.setProperty('--line-height', s.lineHeight);
  root.style.setProperty('--letter-spacing', `${s.letterSpacing}em`);

  const flags = {
    reduceMotion: s.reduceMotion || prefersReducedMotion.matches,
    reduceTransparency: s.reduceTransparency,
    underlineLinks: s.underlineLinks,
    strongFocus: s.strongFocus,
    largeTargets: s.largeTargets,
    alwaysTimestamps: s.alwaysTimestamps,
    boldText: s.boldText,
  };
  for (const [key, val] of Object.entries(flags)) root.dataset[key] = String(val);
}

// Re-resolve when the OS theme or motion preference changes.
prefersDark.addEventListener?.('change', applySettings);
prefersReducedMotion.addEventListener?.('change', applySettings);

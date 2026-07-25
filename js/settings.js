// settings.js — per-user settings: schema, theme registry, persistence and
// applying everything to the document. UI wiring lives in ui.js.

import { store } from './store.js';

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

export function loadSettings(userId) {
  currentUserId = userId;
  current = { ...DEFAULTS, ...store.read(`settings:${userId}`, {}) };
  return current;
}

export function getSettings() { return current; }

export function setSetting(key, value) {
  current[key] = value;
  if (currentUserId) store.write(`settings:${currentUserId}`, current);
  applySettings();
}

export function resetSettings() {
  current = { ...DEFAULTS };
  if (currentUserId) store.write(`settings:${currentUserId}`, current);
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

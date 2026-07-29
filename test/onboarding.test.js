// The three things a new account needs, and the dashboard's own settings.
//
// These are front-end features, so most of what can be checked from here is the
// wiring: that the elements the script reaches for exist, and that the specific
// mistakes each of these features was shipped with once do not come back. Those
// regressions are the point of the file — every assertion below corresponds to
// something that was actually broken.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

const html = read('../public/index.html');
const ui = read('../public/js/ui.js');
const adminHtml = read('../server/admin-ui/index.html');
const adminJs = read('../server/admin-ui/admin.js');
const adminCss = read('../server/admin-ui/admin.css');

describe('asking for notification permission', () => {
  test('the prompt and its two buttons are in the page and wired', () => {
    for (const id of ['notif-prompt', 'notif-prompt-text', 'notif-prompt-enable', 'notif-prompt-dismiss']) {
      assert.match(html, new RegExp(`id="${id}"`), `#${id} must exist`);
      assert.ok(ui.includes(`#${id}`), `#${id} must be used by the script`);
    }
    assert.match(html, /id="notif-prompt"[^>]*\bhidden\b/, 'it starts hidden, and is offered only when useful');
  });

  test('permission is requested from inside the click, not on load', () => {
    // Some platforms refuse a permission request that is not in a user gesture,
    // and a prompt on load is the thing everybody dismisses reflexively.
    const handler = /#notif-prompt-enable'\)\.addEventListener\('click',[\s\S]*?\n  \}\);/.exec(ui)?.[0] || '';
    assert.match(handler, /ensureNotifPermission\(\)/, 'the request happens in the handler');
    assert.ok(!/^\s*await ensureNotifPermission\(\)/m.test(ui.replace(handler, '')),
      'and nowhere outside a handler');
  });

  test('it is not offered when the browser has already decided', () => {
    const fn = /function maybeOfferNotifications\(\)[\s\S]*?\n\}/.exec(ui)?.[0] || '';
    assert.ok(fn, 'the guard exists');
    assert.match(fn, /Notification\.permission !== 'default'/,
      'granted needs nothing and denied cannot be undone from a page');
    assert.match(fn, /notifPromptDismissed/, 'and "Not now" is remembered');
  });

  test('iOS is told to install first rather than shown a useless button', () => {
    const fn = /function maybeOfferNotifications\(\)[\s\S]*?\n\}/.exec(ui)?.[0] || '';
    assert.match(fn, /iP\(hone\|ad\|od\)/, 'Safari only exposes notifications to an installed app');
    assert.match(fn, /Add to Home Screen/);
  });
});

describe('the notification actually makes a sound', () => {
  test('silent is not set on the notification', () => {
    const fn = /function notify\([\s\S]*?\n\}/.exec(ui)?.[0] || '';
    assert.ok(fn, 'notify() exists');
    assert.ok(!/silent:\s*true/.test(fn),
      'silent: true was the whole reason notifications arrived without a sound');
  });

  test('only one sound plays, not the chime and the notification together', () => {
    assert.match(ui, /const shown = notify\(/, 'notify reports whether it fired');
    assert.match(ui, /if \(!shown\) playBlip\(\);/, 'so the chime is the fallback, not an addition');
  });

  test('the audio context is unlocked on the first gesture', () => {
    // Browsers create it suspended; without this the chime did nothing until the
    // person happened to click something, which is not when they need telling.
    assert.match(ui, /function unlockAudioOnFirstGesture/);
    assert.match(ui, /\{ once: true, passive: true \}/);
    assert.match(ui, /unlockAudioOnFirstGesture\(\);/, 'and it is called at start-up');
  });
});

describe('finding people', () => {
  test('the sidebar has a labelled button, not only an icon', () => {
    assert.match(html, /id="btn-find-people"/);
    assert.match(html, /Find people/, 'labelled in words');
    assert.ok(ui.includes("$('#btn-find-people').addEventListener('click', openNewChat)"),
      'and it opens the same directory the compose icon does');
  });

  test('it sits above the conversation list, where an empty list is', () => {
    const sidebar = /<nav id="sidebar"[\s\S]*?<\/nav>/.exec(html)?.[0] || '';
    assert.ok(sidebar.indexOf('btn-find-people') < sidebar.indexOf('id="convo-list"'),
      'a new account sees it before the empty space');
  });
});

describe('the dashboard settings panel', () => {
  test('the cog and every control it drives exist', () => {
    assert.match(adminHtml, /id="btn-settings"/);
    assert.match(adminHtml, /id="settings-dialog"/);
    for (const id of ['ds-r', 'ds-g', 'ds-b', 'ds-hex', 'ds-swatch', 'ds-contrast',
      'ds-refresh', 'ds-tab', 'ds-absolute', 'ds-compact', 'ds-blur', 'ds-restore', 'ds-reset-colour']) {
      assert.match(adminHtml, new RegExp(`id="${id}"`), `#${id} must exist`);
      assert.ok(adminJs.includes(`#${id}`), `#${id} must be used by the script`);
    }
  });

  test('the accent is a variable the sliders can drive', () => {
    assert.match(adminCss, /--accent-r:/, 'the channels are separate custom properties');
    assert.match(adminCss, /--accent: rgb\(var\(--accent-r\)/, 'and the accent is composed from them');
    assert.match(adminJs, /setProperty\('--accent-r'/);
  });

  test('contrast is reported, so an unreadable colour is not a silent choice', () => {
    assert.match(adminJs, /function luminance/);
    assert.match(adminJs, /passes AA/);
    assert.match(adminJs, /hard to read/);
  });

  test('settings stay in the browser and are never sent to the server', () => {
    assert.match(adminJs, /localStorage\.setItem\(SETTINGS_KEY/);
    // No route should exist for them, and the client should not invent one.
    assert.ok(!/\/admin\/settings/.test(adminJs), 'there is no settings endpoint to call');
    assert.ok(!/\/admin\/settings/.test(read('../server/index.js')), 'and none on the server');
  });

  test('auto-refresh pauses while a dialog is open', () => {
    const fn = /function startAutoRefresh\(\)[\s\S]*?\n\}/.exec(adminJs)?.[0] || '';
    assert.match(fn, /dialog\[open\]/,
      'refreshing under somebody mid-decision is worse than a stale count');
  });

  test('reported text can be held behind a click, as a real button', () => {
    const fn = /function quotedBlock\([\s\S]*?\n\}/.exec(adminJs)?.[0] || '';
    assert.match(fn, /settings\.blurReported/);
    assert.match(fn, /createElement\('button'\)/, 'keyboard-reachable, not a click-only target');
    assert.ok(!/innerHTML/.test(fn), 'and still no markup interpolation for hostile text');
  });

  test('start() runs after every declaration it reads', () => {
    // `settings` is a top-level `let`. Calling start() above that line put it in
    // the temporal dead zone and the whole dashboard failed to render — which is
    // exactly how this file was first written.
    const startCall = adminJs.lastIndexOf('\nstart();');
    const settingsDecl = adminJs.indexOf('let settings =');
    assert.ok(settingsDecl !== -1, 'settings is declared');
    assert.ok(startCall > settingsDecl,
      'start() must be invoked below `let settings`, or it throws before rendering');
    assert.equal((adminJs.match(/^start\(\);$/gm) || []).length, 1, 'and only once');
  });
});

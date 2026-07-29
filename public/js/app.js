// app.js — boot: restore a session if one exists, otherwise drive the sign-in
// screen. All credential checking happens on the server.

import { $, $$, initials } from './util.js';
import * as api from './api.js';
import * as db from './store.js';
import { passwordStrength } from './palette.js';
import { loadCachedSettings, applySettings } from './settings.js';
import { initUI } from './ui.js';

// Paint the last account's theme before anything else, so a returning
// dark-mode user is not flashed with a bright page.
const device = db.deviceInfo();
loadCachedSettings(device.lastUserId);
applySettings();

/* ---------- helpers ---------- */

function showView(name) {
  for (const view of $$('.auth-view')) view.hidden = view.dataset.view !== name;
  $(`.auth-view[data-view="${name}"] input:not([type="hidden"])`)?.focus();
}

function fieldError(sel, msg) {
  const el = $(sel);
  el.textContent = msg || '';
  el.hidden = !msg;
  const input = el.closest('.field')?.querySelector('input');
  input?.setAttribute('aria-invalid', msg ? 'true' : 'false');
}

function busy(form, on) {
  for (const el of form.querySelectorAll('button, input')) el.disabled = on;
}

async function enterApp(user) {
  // If the session ends underneath us — expired, password changed on another
  // device, or the account suspended — reload once to the sign-in screen.
  // Trying to sign in there is what surfaces the reason.
  let bouncing = false;
  api.setUnauthorizedHandler(() => {
    if (bouncing) return;
    bouncing = true;
    location.reload();
  });

  // A guest session must not overwrite the remembered real account.
  db.rememberDevice(user.isGuest
    ? {}
    : { lastUserId: user.id, lastUserName: user.name, hasPin: user.hasPin });
  db.hydrate(await api.bootstrap());
  // The bootstrap's own view of you, not the sign-in response: it is fresher and
  // it is the complete one. A sign-in reply carries what the form needed, while
  // bootstrap carries everything the app renders from — including fields the
  // server only sends to some accounts.
  initUI(db.currentUser() || user, { onSignOut: () => location.reload() });
}

function wirePasswordToggle(btnSel, inputSel) {
  const btn = $(btnSel);
  const input = $(inputSel);
  btn.addEventListener('click', () => {
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    btn.textContent = show ? 'Hide' : 'Show';
    btn.setAttribute('aria-pressed', String(show));
    input.focus();
  });
}

/* ---------- sign in ---------- */

wirePasswordToggle('#toggle-signin-pw', '#signin-password');
wirePasswordToggle('#toggle-signup-pw', '#signup-password');
wirePasswordToggle('#toggle-reset-pw', '#reset-password');

for (const btn of $$('[data-goto]')) {
  btn.addEventListener('click', () => showView(btn.dataset.goto));
}

$('#signin-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  fieldError('#signin-email-err');
  fieldError('#signin-password-err');
  $('#appeal-offer').hidden = true;
  const form = e.currentTarget;
  busy(form, true);
  try {
    const { user } = await api.login($('#signin-email').value.trim(), $('#signin-password').value);
    await enterApp(user);
  } catch (err) {
    fieldError('#signin-password-err', err.message);
    // Offer the appeal only when the refusal was a suspension. Any other
    // failure — wrong password, no account — must not hint that appealing is a
    // thing, or it becomes a way to probe for suspended addresses.
    if (err.status === 403 && /suspended/i.test(err.message)) {
      $('#appeal-offer').hidden = false;
      suspensionNotice = err.message;
    }
  } finally {
    busy(form, false);
  }
});

/* ---------- appealing a suspension ---------- */

// What the server said, repeated in the dialog so the reason is in front of
// whoever is writing about it.
let suspensionNotice = '';
const APPEAL_MAX = 2000;

$('#btn-appeal').addEventListener('click', () => {
  $('#appeal-reason-shown').textContent = suspensionNotice;
  $('#appeal-message').value = '';
  $('#appeal-remaining').textContent = String(APPEAL_MAX);
  fieldError('#appeal-error');
  $('#appeal-dialog').showModal();
  $('#appeal-message').focus();
});

$('#appeal-message').addEventListener('input', (e) => {
  $('#appeal-remaining').textContent = String(Math.max(APPEAL_MAX - e.target.value.length, 0));
});

$('#appeal-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const message = $('#appeal-message').value.trim();
  if (!message) return fieldError('#appeal-error', 'Write a short note first.');
  const btn = e.target.querySelector('button[type="submit"]');
  btn.disabled = true;
  try {
    // The password is re-read from the sign-in form rather than held anywhere:
    // the appeal has no session, so it authenticates the same way signing in
    // does, and this is the one place that value already lives.
    await api.appeal(
      $('#signin-email').value.trim(),
      $('#signin-password').value,
      message,
    );
    $('#appeal-dialog').close();
    $('#appeal-offer').hidden = true;
    fieldError('#signin-password-err',
      'Your message has been sent to the people who run this server.');
  } catch (err) {
    fieldError('#appeal-error', err.message);
  } finally {
    btn.disabled = false;
  }
});

for (const btn of $$('[data-close-dialog]')) {
  btn.addEventListener('click', () => btn.closest('dialog')?.close());
}

/* ---------- sign up ---------- */

$('#signup-password').addEventListener('input', () => {
  const { score, label } = passwordStrength($('#signup-password').value);
  const bar = $('#pw-meter-bar');
  bar.style.width = `${Math.min(score, 5) * 20}%`;
  bar.className = score >= 4 ? 'good' : score >= 3 ? 'ok' : '';
  $('#pw-meter-label').textContent = label;
});

$('#signup-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  for (const sel of ['#signup-name-err', '#signup-email-err', '#signup-password-err']) fieldError(sel);
  const name = $('#signup-name').value.trim();
  const email = $('#signup-email').value.trim();
  const password = $('#signup-password').value;
  if (!name) return fieldError('#signup-name-err', 'Enter your name.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fieldError('#signup-email-err', 'Enter a valid email address.');
  if (password.length < 8) return fieldError('#signup-password-err', 'Password must be at least 8 characters.');

  const form = e.currentTarget;
  busy(form, true);
  try {
    const { user } = await api.signup(name, email, password);
    await enterApp(user);
  } catch (err) {
    fieldError(err.status === 409 ? '#signup-email-err' : '#signup-password-err', err.message);
  } finally {
    busy(form, false);
  }
});

/* ---------- one-time email code ---------- */

$('#btn-magic').addEventListener('click', () => {
  $('[data-magic-step="1"]').hidden = false;
  $('[data-magic-step="2"]').hidden = true;
  showView('magic');
});

async function magicSend() {
  fieldError('#magic-email-err');
  try {
    const { code } = await api.requestCode($('#magic-email').value.trim());
    $('#magic-demo-code').textContent = code;
    $('[data-magic-step="1"]').hidden = true;
    $('[data-magic-step="2"]').hidden = false;
    $('#magic-code').value = '';
    $('#magic-code').focus();
  } catch (err) {
    fieldError('#magic-email-err', err.message);
  }
}

$('#magic-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if ($('[data-magic-step="2"]').hidden) return magicSend();
  fieldError('#magic-code-err');
  try {
    const { user } = await api.verifyCode($('#magic-email').value.trim(), $('#magic-code').value);
    await enterApp(user);
  } catch (err) {
    fieldError('#magic-code-err', err.message);
  }
});

$('#magic-resend').addEventListener('click', magicSend);

/* ---------- password reset ---------- */

$('#reset-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const onCodeStep = !$('[data-reset-step="2"]').hidden;
  const email = $('#reset-email').value.trim();

  if (!onCodeStep) {
    fieldError('#reset-email-err');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return fieldError('#reset-email-err', 'Enter a valid email address.');
    }
    try {
      const res = await api.requestReset(email);
      $('[data-reset-step="1"]').hidden = true;
      $('[data-reset-step="2"]').hidden = false;
      if (res.delivery === 'demo-inbox') {
        $('#reset-demo-inbox').hidden = false;
        $('#reset-demo-code').textContent = res.code;
      } else {
        // Either it was emailed, or the address is not registered — the server
        // deliberately does not say which.
        $('#reset-sent-note').hidden = false;
        $('#reset-sent-note').textContent = res.to
          ? `If that address is registered, a code is on its way to ${res.to}.`
          : 'If that address is registered, a code is on its way.';
      }
      $('#reset-code').focus();
    } catch (err) {
      fieldError('#reset-email-err', err.message);
    }
    return;
  }

  fieldError('#reset-err');
  const password = $('#reset-password').value;
  if (password.length < 8) return fieldError('#reset-err', 'Password must be at least 8 characters.');
  try {
    const { user } = await api.confirmReset(email, $('#reset-code').value, password);
    await enterApp(user);
  } catch (err) {
    fieldError('#reset-err', err.message);
  }
});

/* ---------- passkey ---------- */

$('#btn-passkey').addEventListener('click', async (e) => {
  fieldError('#signin-email-err');
  if (!api.passkeysSupported()) {
    return fieldError('#signin-email-err',
      'Passkeys need a secure context. Use localhost or HTTPS, or sign in with your password.');
  }
  const btn = e.currentTarget;
  btn.disabled = true;
  try {
    const { user } = await api.passkeySignIn();
    await enterApp(user);
  } catch (err) {
    // Cancelling the browser prompt is not an error worth shouting about.
    if (err.name !== 'NotAllowedError' && err.name !== 'AbortError') {
      fieldError('#signin-email-err', err.message || 'Passkey sign-in failed.');
    }
  } finally {
    btn.disabled = false;
  }
});

/* ---------- guest ---------- */

$('#btn-guest').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  try {
    const { user } = await api.guest();
    await enterApp(user);
  } catch (err) {
    fieldError('#signin-email-err', err.message);
  } finally {
    btn.disabled = false;
  }
});

/* ---------- quick-unlock PIN ---------- */

function renderPinUnlock() {
  const slot = $('#pin-unlock-slot');
  slot.innerHTML = '';
  if (!device.hasPin || !device.lastUserId) return;

  const box = document.createElement('div');
  box.className = 'pin-unlock';
  box.innerHTML = `
    <span class="avatar" aria-hidden="true"></span>
    <div class="pin-unlock-info"><strong></strong><span>Unlock with your PIN</span></div>
    <label class="visually-hidden" for="pin-unlock-input">PIN</label>
    <input id="pin-unlock-input" type="password" inputmode="numeric" maxlength="6" placeholder="PIN" autocomplete="off">`;
  box.querySelector('.avatar').textContent = initials(device.lastUserName || '?');
  box.querySelector('strong').textContent = device.lastUserName || 'Your account';
  slot.append(box);

  const input = box.querySelector('input');
  input.addEventListener('input', async () => {
    if (input.value.length < 4) return;
    try {
      const { user } = await api.pinLogin(device.lastUserId, input.value);
      await enterApp(user);
    } catch (err) {
      if (input.value.length >= 6 || err.status === 429) {
        input.value = '';
        fieldError('#signin-password-err', err.message);
      }
    }
  });
}

/* ---------- installable app ---------- */

if ('serviceWorker' in navigator) {
  // Registered after load so fetching the worker never competes with the
  // first paint or the bootstrap request.
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // Not fatal: without it the app simply has no offline shell.
    });
  });
}

/* ---------- boot ---------- */

try {
  const { user } = await api.me();
  await enterApp(user);
} catch {
  renderPinUnlock();
  showView('signin');
}

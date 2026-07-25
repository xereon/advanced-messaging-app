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
  // A guest session must not overwrite the remembered real account.
  db.rememberDevice(user.isGuest
    ? {}
    : { lastUserId: user.id, lastUserName: user.name, hasPin: user.hasPin });
  db.hydrate(await api.bootstrap());
  initUI(user, { onSignOut: () => location.reload() });
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

for (const btn of $$('[data-goto]')) {
  btn.addEventListener('click', () => showView(btn.dataset.goto));
}

$('#signin-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  fieldError('#signin-email-err');
  fieldError('#signin-password-err');
  const form = e.currentTarget;
  busy(form, true);
  try {
    const { user } = await api.login($('#signin-email').value.trim(), $('#signin-password').value);
    await enterApp(user);
  } catch (err) {
    fieldError('#signin-password-err', err.message);
  } finally {
    busy(form, false);
  }
});

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

/* ---------- passkey (pending real WebAuthn verification) ---------- */

$('#btn-passkey').addEventListener('click', () => {
  fieldError('#signin-email-err',
    'Passkey sign-in is not available yet — it needs server-side WebAuthn verification. Use your password or an email code.');
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

/* ---------- boot ---------- */

try {
  const { user } = await api.me();
  await enterApp(user);
} catch {
  renderPinUnlock();
  showView('signin');
}

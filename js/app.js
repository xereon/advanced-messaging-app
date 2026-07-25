// app.js — boot: seed demo data, drive the auth screen, hand over to the chat UI.

import { $, $$, initials } from './util.js';
import * as db from './store.js';
import * as auth from './auth.js';
import { seedBots, seedConvosFor } from './bots.js';
import { loadSettings, applySettings } from './settings.js';
import { initUI } from './ui.js';

seedBots();

// Apply the last user's saved theme to the login screen too, so a returning
// dark-mode user is not flashed with a bright page.
const device = db.deviceInfo();
if (device.lastUserId) loadSettings(device.lastUserId);
applySettings();

/* ---------- helpers ---------- */

function showView(name) {
  for (const view of $$('.auth-view')) view.hidden = view.dataset.view !== name;
  const first = $(`.auth-view[data-view="${name}"] input:not([type="hidden"])`);
  first?.focus();
}

function fieldError(sel, msg) {
  const el = $(sel);
  el.textContent = msg || '';
  el.hidden = !msg;
  const input = el.closest('.field')?.querySelector('input');
  input?.setAttribute('aria-invalid', msg ? 'true' : 'false');
}

function enterApp(user, method, remember = false) {
  db.setSession(user.id, method, remember);
  seedConvosFor(user);
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
  const email = $('#signin-email').value.trim();
  const password = $('#signin-password').value;
  if (!email) return fieldError('#signin-email-err', 'Enter your email address.');
  const user = db.findUserByEmail(email);
  if (!user || !user.hash) return fieldError('#signin-email-err', 'No account found for that email.');
  if (!(await auth.verifyPassword(user, password))) {
    return fieldError('#signin-password-err', 'Incorrect password. Try again, or use another sign-in method.');
  }
  enterApp(user, 'password', $('#remember-me').checked);
});

/* ---------- sign up ---------- */

$('#signup-password').addEventListener('input', () => {
  const { score, label } = auth.passwordStrength($('#signup-password').value);
  const bar = $('#pw-meter-bar');
  bar.style.width = `${Math.min(score, 5) * 20}%`;
  bar.className = score >= 4 ? 'good' : score >= 3 ? 'ok' : '';
  $('#pw-meter-label').textContent = label;
});

$('#signup-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  fieldError('#signup-name-err');
  fieldError('#signup-email-err');
  fieldError('#signup-password-err');
  const name = $('#signup-name').value.trim();
  const email = $('#signup-email').value.trim();
  const password = $('#signup-password').value;
  if (!name) return fieldError('#signup-name-err', 'Enter your name.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fieldError('#signup-email-err', 'Enter a valid email address.');
  if (password.length < 8) return fieldError('#signup-password-err', 'Password must be at least 8 characters.');
  try {
    const user = await auth.createAccount({ name, email, password });
    enterApp(user, 'password', true);
  } catch (err) {
    fieldError('#signup-email-err', err.message);
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
    const code = await auth.magicStart($('#magic-email').value);
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
    const user = await auth.magicVerify($('#magic-email').value, $('#magic-code').value);
    enterApp(user, 'magic', $('#remember-me').checked);
  } catch (err) {
    fieldError('#magic-code-err', err.message);
  }
});

$('#magic-resend').addEventListener('click', magicSend);

/* ---------- passkey ---------- */

$('#btn-passkey').addEventListener('click', async () => {
  if (!auth.passkeysSupported()) {
    return fieldError('#signin-email-err', 'Passkeys need https or localhost. Use another method here.');
  }
  try {
    const user = await auth.passkeySignIn();
    enterApp(user, 'passkey', $('#remember-me').checked);
  } catch (err) {
    if (err.name !== 'NotAllowedError') fieldError('#signin-email-err', err.message || 'Passkey sign-in failed.');
  }
});

/* ---------- guest ---------- */

$('#btn-guest').addEventListener('click', () => {
  enterApp(auth.createGuest(), 'guest', false);
});

/* ---------- quick-unlock PIN ---------- */

function renderPinUnlock() {
  const slot = $('#pin-unlock-slot');
  slot.innerHTML = '';
  const lastUser = device.lastUserId ? db.getUser(device.lastUserId) : null;
  if (!lastUser?.pinHash) return;

  const box = document.createElement('div');
  box.className = 'pin-unlock';
  box.innerHTML = `
    <span class="avatar" aria-hidden="true" style="--av-bg:${lastUser.avatarColor || '#334155'}">${initials(lastUser.name)}</span>
    <div class="pin-unlock-info"><strong></strong><span>Unlock with your PIN</span></div>
    <label class="visually-hidden" for="pin-unlock-input">PIN for ${lastUser.name}</label>
    <input id="pin-unlock-input" type="password" inputmode="numeric" maxlength="6" placeholder="PIN" autocomplete="off">`;
  box.querySelector('strong').textContent = lastUser.name;
  slot.append(box);

  const input = box.querySelector('input');
  input.addEventListener('input', async () => {
    if (input.value.length < 4) return;
    if (await auth.verifyPin(lastUser, input.value)) {
      enterApp(lastUser, 'pin', true);
    } else if (input.value.length === 6) {
      input.value = '';
      fieldError('#signin-password-err', 'Wrong PIN — try again or sign in with your password.');
    }
  });
}

/* ---------- boot ---------- */

const session = db.getSession();
db.pruneGuests(session?.userId);
const restored = session && db.getUser(session.userId);
if (restored) {
  enterApp(restored, session.method, device.remember);
} else if (device.remember && device.lastUserId && db.getUser(device.lastUserId)) {
  // "Keep me signed in" — restore without a prompt.
  enterApp(db.getUser(device.lastUserId), 'remembered', true);
} else {
  renderPinUnlock();
  showView('signin');
}

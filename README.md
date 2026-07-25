# Relay — Advanced Messaging App

An extremely simple yet surprisingly advanced text-messaging app with a corporate-grade
UI, deep accessibility settings, colour-blind-safe themes and five sign-in methods.
**Zero dependencies, zero build step, zero servers** — plain HTML, CSS and JavaScript,
with everything stored locally in your browser.

![Made with vanilla JS](https://img.shields.io/badge/dependencies-none-2458E6)

## Running it

Serve the folder over HTTP (ES modules and passkeys don't work from `file://`):

```bash
# any of these, from the project root:
python3 -m http.server 8123
php -S localhost:8123
npx serve .
```

Then open <http://localhost:8123>. Under XAMPP it also works straight from
`http://localhost/advanced-messaging-app/`.

## Sign-in options

| Method | Notes |
| --- | --- |
| **Email + password** | Salted PBKDF2-SHA-256 (210k iterations) via WebCrypto — never stored in plain text |
| **Quick-unlock PIN** | 4–6 digits, per device, offered on the login screen for the last account |
| **Passkey (WebAuthn)** | Real `navigator.credentials` flow; register under Settings → Account & security |
| **One-time email code** | Demo inbox shows the 6-digit code on screen (no real email is sent) |
| **Guest** | Instant ephemeral session, deleted on sign-out |

## Messaging features

- Live cross-tab messaging: open two tabs, sign in as two accounts, and chat for real
  (BroadcastChannel sync with presence heartbeats)
- Simulated colleagues who read, type and reply — the demo is alive with one account
- Delivery states with distinct icons (sent ✓, delivered ✓✓, read), typing indicators,
  read receipts you can turn off, emoji reactions, replies with quoting, editing,
  deleting, drafts per conversation, pinning, muting, unread badges and dividers
- Global search (conversations + full-text messages) and in-conversation search with
  match cycling
- Groups, message formatting (`**bold**`, `*italic*`, `` `code` ``, auto-links),
  day separators, "new messages" jump chip, per-conversation TXT export and a full
  JSON data export
- Keyboard shortcuts: `Ctrl+K` search, `Alt+↑/↓` switch conversation, `Alt+N` new chat,
  `↑` edits your last message, `Ctrl+,` settings, `?` help

## Accessibility

- **10 themes**, all WCAG AA: Corporate Light/Dark, Midnight Slate, High Contrast
  Light/Dark, and four colour-vision themes — **deuteranopia**, **protanopia**,
  **tritanopia** and **monochrome** — built on the Okabe-Ito palette. Status is always
  conveyed with icons and text, never colour alone.
- Text size (85–150 %), line spacing, letter spacing, bold text, five font choices
  (including a dyslexia-friendly stack) and three layout densities
- Reduce motion & reduce transparency (also honours `prefers-reduced-motion` and
  Windows forced-colors mode), high-visibility focus outlines, always-underline links,
  44 px large-target mode
- Full keyboard operability, skip link, semantic landmarks, focus-trapped native
  dialogs, `aria-live` announcements for incoming messages (toggleable), labelled
  controls throughout

## Privacy

Everything — accounts, messages, settings — lives in `localStorage` under the `relay:`
namespace. Nothing ever leaves your machine. Settings → Data & privacy has one-click
export and a full wipe.

## Project layout

```
index.html        app shell, icon sprite, dialogs
css/app.css       design system: tokens, 10 themes, components, a11y switches
js/app.js         boot + auth screen wiring
js/auth.js        password / PIN / passkey / email-code / guest
js/store.js       localStorage model + BroadcastChannel cross-tab sync
js/bots.js        simulated colleagues (read receipts, typing, replies)
js/settings.js    settings schema, theme registry, DOM application
js/ui.js          chat UI: sidebar, messages, composer, search, settings panels
js/util.js        helpers (formatting, markdown-lite, downloads)
```

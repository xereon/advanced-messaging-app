# Relay — Accessible Messaging

A real messaging app: accounts and messages live on a server, sync live between
devices, and the interface is built for people who need it to be legible.
**No runtime dependencies** — the front end is plain HTML, CSS and JavaScript;
the back end is Node's own `node:http`, `node:sqlite` and `node:crypto`.

![no dependencies](https://img.shields.io/badge/dependencies-none-2458E6)
![node 22+](https://img.shields.io/badge/node-22.5%2B-4D7C0F)

## Running it

Requires **Node 22.5 or newer** (for the built-in SQLite module).

```bash
npm start
```

Then open <http://localhost:8130>. The database is created automatically at
`data/relay.db`.

```bash
npm test    # 45 tests covering auth, authorization and messaging
npm run dev # restarts on change
```

### Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8130` | HTTP port |
| `RELAY_DB` | `data/relay.db` | SQLite database path |
| `RELAY_SECURE` | unset | Set to `1` behind HTTPS to add `Secure` to the session cookie |
| `RELAY_RATE_LIMIT` | on | Set to `off` to disable rate limiting (tests only) |

**Deploying:** put it behind a TLS-terminating reverse proxy, set
`RELAY_SECURE=1`, and make sure the proxy does not buffer `text/event-stream`
(nginx: `proxy_buffering off`) or live updates will stall.

## Architecture

```
server/
  index.js     HTTP server, routing, static hosting, CSRF and security headers
  db.js        SQLite schema, migrations, transactions, row shaping
  auth.js      scrypt hashing, sessions, login codes, rate limiting
  api.js       REST handlers — every route re-checks membership
  realtime.js  Server-Sent Events hub, presence, resumable streams
  bots.js      the simulated colleagues, running server-side
public/
  index.html   app shell, icon sprite, dialogs
  css/app.css  design system: tokens, 10 themes, components, a11y switches
  js/api.js    HTTP + EventSource client
  js/store.js  client cache over the API; keeps reads synchronous
  js/ui.js     chat UI: sidebar, messages, composer, search, settings
  js/settings.js, js/palette.js, js/util.js
test/          server tests (node:test)
```

**How sync works.** The client hydrates a full snapshot from `/api/bootstrap`,
then holds an SSE stream. Every change is published to exactly the users
entitled to see it. Sends are optimistic — the message appears immediately as
"Sending", then reconciles against the server's copy by client id. `EventSource`
reconnects on its own and replays what it missed via `Last-Event-ID`; after a
long outage the client pulls a fresh snapshot instead.

## Security

- Passwords and PINs are hashed with **scrypt** (N=16384) and a per-record random
  salt, compared with `timingSafeEqual`. Plaintext is never stored, and no
  password material is ever sent to a client.
- Sessions are 256-bit random tokens delivered in an **httpOnly, SameSite=Lax**
  cookie. Only a SHA-256 digest is stored, so a database leak hands out no live
  sessions. Changing your password invalidates every other device.
- **Every** conversation route re-checks membership server-side; ids from the
  client are never trusted. Editing and deleting are restricted to the author.
- State-changing requests require an `X-Relay-Client` header that a cross-site
  form cannot set.
- Login, PIN, sign-up and code requests are rate limited per address and per
  account. Sign-in returns the same message and does comparable work whether or
  not the address is registered.

## Sign-in options

| Method | Notes |
| --- | --- |
| **Email + password** | scrypt-hashed server-side |
| **One-time email code** | Real single-use code with a 10-minute expiry and an attempt cap. No mail transport is configured yet, so the code is shown in an on-screen demo inbox — wiring SMTP at `/auth/code/request` is the only remaining step |
| **Quick-unlock PIN** | 4–6 digits, verified server-side, offered on the sign-in screen for the last account used on this device |
| **Guest** | Instant session. Several guests can be signed in at once, each with a unique name and colour, and they can find and message each other. A guest who never chatted is removed on sign-out; one who did is retired, so their name still resolves in everyone else's history |

**Passkeys are not available yet.** Real WebAuthn needs server-side signature
verification against a stored credential public key; a client-only version
would look like security without providing any, so the control is disabled
until it is implemented properly.

## Messaging

Live delivery with distinct status icons (sending, sent ✓, delivered ✓✓, read),
typing indicators, read receipts you can switch off (the server then withholds
them from others while still tracking your own unread count), emoji reactions,
replies with quoting, editing, deleting, per-conversation drafts, pinning,
muting, unread badges and dividers, groups, message formatting
(`**bold**`, `*italic*`, `` `code` ``, auto-links), day separators, and JSON
export of everything the server holds about you.

Search covers conversations, **people** (by name, email or role) and full
message history, with a separate in-conversation search that cycles matches.
Anyone you can find you can add to **contacts**, which get their own sidebar tab
and sort to the top of search.

Keyboard: `Ctrl+K` search, `Alt+↑/↓` switch conversation, `Alt+N` new chat,
`↑` edit your last message, `Ctrl+,` settings, `?` help, `Esc` cancel.

## Accessibility

- **10 themes**, all WCAG AA: Corporate Light/Dark, Midnight Slate, High Contrast
  Light/Dark, and four colour-vision themes — **deuteranopia**, **protanopia**,
  **tritanopia** and **monochrome** — built on the Okabe-Ito palette. Status is
  always carried by icons and text, never colour alone.
- Text size (85–150 %), line spacing, letter spacing, bold text, five font
  choices including a dyslexia-friendly stack, three layout densities.
- Reduce motion and reduce transparency (also honouring `prefers-reduced-motion`
  and Windows forced-colors), high-visibility focus outlines, always-underline
  links, 44 px large-target mode, always-on timestamps.
- Full keyboard operability, skip link, semantic landmarks, focus-trapped native
  dialogs, and `aria-live` announcements for incoming messages.

Settings are stored on your account, so they follow you between devices.

## Known gaps

These are real and worth naming rather than hiding:

- **Passkeys** — see above.
- **Email delivery** — login codes are generated and verified for real, but
  displayed on screen instead of emailed.
- **Message pagination** — `/api/bootstrap` sends the most recent 200 messages
  per conversation and there is no "load older" control yet.
- **Rendering** — the message list is rebuilt on each change, which is fine at
  present scale but wants incremental updates or virtualization for very long
  histories.
- **Keyboard depth in the message list** — each message exposes its action
  buttons in the tab order; this should become a roving tabindex so the list is
  a single tab stop.
- **Attachments** — text only for now.

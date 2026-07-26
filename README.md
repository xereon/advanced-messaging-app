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
npm test    # 97 tests: auth, WebAuthn, URL safety, authorization, messaging, files
npm run dev # restarts on change
```

### Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8130` | HTTP port |
| `RELAY_DB` | `data/relay.db` | SQLite database path |
| `RELAY_UPLOADS` | `data/uploads` | Where attachments are stored |
| `RELAY_SECURE` | unset | Set to `1` behind HTTPS to add `Secure` to the session cookie |
| `RELAY_ORIGIN` | unset | Extra allowed WebAuthn origin, if the public origin differs from `Host` |
| `RELAY_RATE_LIMIT` | on | Set to `off` to disable rate limiting (tests only) |

### Email delivery

Login codes are emailed when SMTP is configured, and shown on screen otherwise.

| Variable | Purpose |
| --- | --- |
| `RELAY_SMTP_HOST` | Enables real delivery when set |
| `RELAY_SMTP_PORT` | Default `587` |
| `RELAY_SMTP_USER` / `RELAY_SMTP_PASS` | Credentials, if the server requires auth |
| `RELAY_SMTP_FROM` | e.g. `Relay <no-reply@example.com>` |
| `RELAY_SMTP_SECURE` | `1` for implicit TLS (port 465) |
| `RELAY_SMTP_INSECURE` | `1` to allow auth without STARTTLS (not recommended) |

The client refuses to send credentials to a server that will not negotiate
STARTTLS unless you explicitly opt in. Once SMTP is configured the code is never
returned in the HTTP response — only a masked address confirming where it went.

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
  webauthn.js  passkey ceremonies: challenges, attestation, signature checks
  cbor.js      minimal CBOR decoder for WebAuthn structures
  files.js     attachment storage, type sniffing, image dimensions
  mailer.js    SMTP client (STARTTLS, AUTH PLAIN/LOGIN)
public/
  index.html   app shell, icon sprite, dialogs
  css/app.css  design system: tokens, 10 themes, components, a11y switches
  js/api.js    HTTP + EventSource client, WebAuthn and upload helpers
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
- **Credentials never touch a URL.** Every form carrying a secret is explicitly
  `method="post"`, so even with JavaScript disabled or broken the browser cannot
  fall back to a GET that would write `?password=` into the address bar, browser
  history, server logs and `Referer` headers. Those forms target a no-JS
  fallback page that drains the request without parsing, storing or echoing
  anything. If a secret-shaped parameter reaches any URL anyway — a stale
  bookmark, a mis-built link — the server answers `303` to the cleaned path
  before the value can be read or logged, keeping harmless parameters intact.
  Auth responses send `Cache-Control: no-store`, the whole app sends
  `Referrer-Policy: no-referrer`, and the 500 handler logs the path only, never
  the query string.

## Sign-in options

| Method | Notes |
| --- | --- |
| **Passkey (WebAuthn)** | Real ceremonies with server-side verification: the server issues single-use challenges, parses the authenticator's CBOR attestation, stores the COSE public key, and verifies each assertion signature over `authenticatorData ‖ SHA-256(clientDataJSON)`. Origin and RP-ID hash are checked, and a signature counter that fails to advance is rejected as a possible cloned authenticator. ES256 and RS256 are supported |
| **Email + password** | scrypt-hashed server-side |
| **One-time email code** | Single-use, 10-minute expiry, attempt-capped. Emailed when SMTP is configured; otherwise shown on screen |
| **Quick-unlock PIN** | 4–6 digits, verified server-side, offered on the sign-in screen for the last account used on this device |
| **Guest** | Instant session. Several guests can be signed in at once, each with a unique name and colour, and they can find and message each other. A guest who never chatted is removed on sign-out; one who did is retired, so their name still resolves in everyone else's history |

Passkeys are managed under Settings → Account & security, where each one can be
listed and revoked. Registration uses `attestation: 'none'`, so the
authenticator's identity is not asserted — only possession of the private key,
which is what signs you in.

## Messaging

**Attachments:** images and files up to 10 MB, four per message, added by button,
drag-and-drop or paste. The stored type is sniffed from the file's own magic
bytes rather than trusted from the client, so a script renamed `.png` is served
as an inert download; only a small allow-list of image types is ever served
inline, behind `Content-Disposition`, `nosniff` and a `default-src 'none'; sandbox`
CSP. Downloads are membership-checked, and deleting a message deletes its files.

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

History loads the most recent 200 messages per conversation, with a **Load
earlier messages** control that pages backwards while holding your reading
position steady.

Keyboard: `Ctrl+K` search, `Alt+↑/↓` switch conversation, `Alt+N` new chat,
`↑` edit your last message, `Ctrl+,` settings, `?` help, `Esc` cancel.
Inside the message list, `↑`/`↓` move between messages, `Home`/`End` jump to the
ends, `Enter` opens a message's actions, and `R`/`E`/`C` reply, edit or copy.

## Layout

The CSS is authored **mobile first**: the base rules are the phone, and each
breakpoint adds capability rather than taking it away.

| Width | Layout |
| --- | --- |
| **Phone** (base) | One pane at a time — the conversation covers the list, with a back button. Search takes its own full-width row on the list screen and steps aside inside a conversation, which takes over the whole screen. Dialogs and menus are bottom sheets with a grab handle. |
| **≥ 480px** | Sign-in options sit side by side; bubbles and padding relax. |
| **≥ 768px** (tablet) | Both panes side by side, back button retired, dialogs become centred panels and menus return to anchored popovers. |
| **≥ 900px** | The settings dialog regains its left-hand section nav. |
| **≥ 1024px** (desktop) | Wider sidebar, keyboard hints in the search field. |

Layout height uses `dvh`, so the collapsing browser chrome on a phone never
crops the composer, and `visualViewport` is consulted only when the on-screen
keyboard is genuinely open. Safe-area insets keep content clear of notches and
home indicators.

**Touch is treated as an input mode, not a screen size.** Message actions were
previously hover-only, which made reply, react and copy unreachable on a phone;
a tap now opens the toolbar, decided per interaction from `pointerType` so a
hybrid touch laptop gets tap *and* hover. Under `pointer: coarse` every control
grows to a 44px target and inputs reach 16px, below which iOS zooms the page on
focus.

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
- The message list is a **single tab stop** using a roving tabindex, so reaching
  the composer never means tabbing through hundreds of per-message buttons.
  Arrow keys move between messages and `Enter` opens the actions for the focused
  one.

Settings are stored on your account, so they follow you between devices.

## Known gaps

Worth naming rather than hiding:

- **Attestation is not validated.** Registration uses `attestation: 'none'`, so
  Relay verifies possession of the key but does not attest which authenticator
  model produced it. That is the right default for a normal deployment; an
  enterprise that must allow-list hardware would need full attestation parsing.
- **Very long histories still render every loaded message.** Updates are now
  incremental and history is paged, so the list only grows when you ask it to,
  but there is no windowing — scrolling back through tens of thousands of
  messages in one sitting would eventually get heavy.
- **Attachments are not scanned or thumbnailed.** Files are stored as uploaded,
  served inertly, and capped at 10 MB; there is no virus scanning, no
  transcoding, and images are sent at full size rather than as thumbnails.
- **No push notifications.** Desktop notifications work while a tab is open;
  there is no service worker or Web Push, so a closed app is silent.
- **Single-node only.** The SSE hub and rate limiter hold state in process, so
  running more than one instance would need a shared bus and store.

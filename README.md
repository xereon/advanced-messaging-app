# Relay — Accessible Messaging

A real messaging app: accounts and messages live on a server, sync live between
devices, and the interface is built for people who need it to be legible.
**No runtime dependencies** — the front end is plain HTML, CSS and JavaScript;
the back end is Node's own `node:http`, `node:sqlite` and `node:crypto`.

![no dependencies](https://img.shields.io/badge/dependencies-none-2458E6)
![node 22+](https://img.shields.io/badge/node-22.5%2B-4D7C0F)

## Installation

Relay has **no dependencies to install** — no `npm install`, no build step, no
database server. Clone it and start it.

### Requirements

| | |
| --- | --- |
| **Node.js 22.5 or newer** | The only requirement. Node's built-in SQLite (`node:sqlite`) landed in 22.5.0, which is what lets the project ship with zero dependencies. Older versions are refused at startup with a message saying so. |
| Disk | A few MB, plus whatever attachments accumulate (capped at 10 MB each). |
| Everything else | Nothing. No Redis, no Postgres, no reverse proxy for local use. |

```bash
node --version     # must be v22.5.0 or higher
```

If it is older, install a current Node — [nodejs.org/en/download](https://nodejs.org/en/download),
or with [nvm](https://github.com/nvm-sh/nvm): `nvm install 22 && nvm use 22`.

### Local install

```bash
git clone https://github.com/xereon/advanced-messaging-app.git
cd advanced-messaging-app
npm start
```

Open <http://localhost:8130> and create an account. That is the whole process.

The database and upload directory are created on first run under `data/`, which
is git-ignored. A new account is seeded with a few conversations so the app is
not empty on first sight.

```bash
npm test     # 97 tests
npm run dev  # restarts on file changes
PORT=3000 npm start
```

**Two accounts on one machine.** A browser keeps one cookie jar per profile, so
signing in twice in two tabs replaces the first session. Use a private window,
a second browser, or a second device to see two people messaging.

### Deploying to a server

Relay listens on plain HTTP and expects TLS to be terminated in front of it.

```bash
sudo useradd --system --home /srv/relay --shell /usr/sbin/nologin relay
sudo git clone https://github.com/xereon/advanced-messaging-app.git /srv/relay
sudo chown -R relay:relay /srv/relay

sudo cp /srv/relay/deploy/relay.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now relay
journalctl -u relay -f
```

Then put nginx in front:

```bash
sudo cp /srv/relay/deploy/nginx.conf /etc/nginx/sites-available/relay
sudo ln -s /etc/nginx/sites-available/relay /etc/nginx/sites-enabled/
# edit server_name and the certificate paths, then
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d relay.example.com
```

Set **`RELAY_SECURE=1`** once TLS is in place (the supplied unit file already
does) so the session cookie is marked `Secure`.

> **The one thing that catches people out:** the live stream is a long-lived
> Server-Sent Events response. If the proxy buffers it, the app loads perfectly
> and then never updates. The supplied nginx config disables buffering for
> `/api/events`; if you use a different proxy, do the equivalent there.

### Deploying on cPanel (Node.js Selector / Passenger)

Shared hosting with cPanel can run Relay through Passenger.

1. Upload or `git clone` the repository into a directory outside `public_html`,
   for example `~/relay`.
2. **Setup Node.js App** → *Create Application*:
   - **Node.js version:** 22.5 or newer. If the list stops short of that,
     Relay cannot run on that host — `node:sqlite` will not exist.
   - **Application root:** `relay`
   - **Application URL:** the domain or subdomain to serve it from
   - **Application startup file:** `app.js`
3. Add environment variables in the same screen: `RELAY_SECURE=1`, plus any
   `RELAY_SMTP_*` values you need.
4. Start the application.

`app.js` at the repository root exists for exactly this: Passenger wants a
single entry file at the application root, and this one reports a startup
failure into the app's stderr log rather than leaving you with a bare 503.
Locally, `node app.js` and `npm start` are equivalent.

Passenger supplies `PORT` itself, and depending on the configuration that is a
TCP port *or* a Unix socket path — Relay accepts either.

**Then append `deploy/cpanel/htaccess-hardening.conf` to the `.htaccess` in your
`public_html`.** Append, do not replace: cPanel writes its own
`PassengerAppRoot` block into that file and removing it takes the site offline.
The additions turn off response buffering so the live stream works, force
HTTPS, raise the upload limit, and — most importantly — stop Apache serving
application internals directly. If the app files sit inside the document root,
Apache can hand out a file that physically exists there before Passenger ever
sees the request, which would publish `data/relay.db` and every uploaded
attachment to anyone who guesses the path.

### Upgrading

```bash
cd /srv/relay
sudo -u relay git pull
sudo systemctl restart relay
```

The schema migrates itself on start (`CREATE TABLE IF NOT EXISTS`), so no
migration step is needed. Take a backup first anyway.

### Backups

Two things matter: `data/relay.db` and `data/uploads/`.

```bash
./deploy/backup.sh /var/backups/relay
```

The script takes a **consistent snapshot of the running database** with
`VACUUM INTO` and tars the attachments, keeping the last 14 sets. Copying
`relay.db` by hand while the server is running can capture a torn write,
because SQLite is in WAL mode — use the script, or stop the service first.

Restoring is a file copy:

```bash
sudo systemctl stop relay
sudo -u relay cp /var/backups/relay/relay-YYYYMMDD-HHMMSS.db /srv/relay/data/relay.db
sudo -u relay tar -xzf /var/backups/relay/uploads-YYYYMMDD-HHMMSS.tar.gz -C /srv/relay/data
sudo systemctl start relay
```

Schedule it with cron: `15 3 * * * /srv/relay/deploy/backup.sh /var/backups/relay`

### Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8130` | TCP port, or a Unix socket path under Passenger |
| `RELAY_DB` | `data/relay.db` | SQLite database path |
| `RELAY_UPLOADS` | `data/uploads` | Where attachments are stored |
| `RELAY_SECURE` | unset | Set to `1` behind HTTPS to add `Secure` to the session cookie |
| `RELAY_ORIGIN` | unset | Extra allowed WebAuthn origin, if the public origin differs from `Host` |
| `RELAY_RATE_LIMIT` | on | Set to `off` to disable rate limiting (tests only) |

#### Email delivery

Login codes are emailed when SMTP is configured, and shown on screen otherwise —
so the app works out of the box and gets real delivery when you want it.

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

Keep `RELAY_SMTP_PASS` out of the unit file; use `EnvironmentFile=` pointing at
a root-owned `0600` file instead.

### Troubleshooting

| Symptom | Cause |
| --- | --- |
| `Relay needs Node 22.5 or newer` | Exactly that. Check `node --version`; a service may use a different Node than your shell. |
| `Cannot find module 'node:sqlite'` | Node older than 22.5 slipped past the check — confirm which binary systemd or Passenger is running. |
| App loads but messages never arrive | The proxy is buffering `/api/events`. See the note above. |
| Signed out on every reload | `RELAY_SECURE=1` while serving over plain HTTP: the browser drops a `Secure` cookie on an insecure origin. |
| Passkeys unavailable | WebAuthn needs a secure context. `localhost` counts; a bare IP or plain-HTTP domain does not. |
| `EADDRINUSE` | Something already holds the port. `PORT=8131 npm start`, or stop the other process. |
| Uploads fail at ~10 MB | The app's own cap. A proxy `client_max_body_size` below that fails earlier and less clearly. |

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
deploy/        systemd unit, nginx config, backup script, cPanel .htaccess
app.js         Passenger entry point for cPanel; `npm start` uses server/index.js
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

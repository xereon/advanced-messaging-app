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
npm test     # 398 tests
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
| `RELAY_SCAN_COMMAND` | unset | External virus scanner for uploads; a non-zero exit rejects the file |
| `RELAY_ENCRYPTION_KEY` | unset | 32-byte key (base64 or hex) that encrypts message bodies at rest. Generate with `npm run encrypt -- --key`, then run `npm run encrypt`. **Lose it and every encrypted message is gone** |
| `RELAY_ADMIN_EMAIL` | unset | Account marked administrator on boot, granting the moderation dashboard. `npm run admin` does the same from a shell |
| `RELAY_VAPID_PUBLIC` / `RELAY_VAPID_PRIVATE` | generated | Web Push identity. Generated once and stored on first use; set these to pin it. Changing them invalidates every existing subscription |
| `RELAY_VAPID_SUBJECT` | `mailto:admin@localhost` | Contact address push services can use to reach you |
| `RELAY_DEMO_BOTS` | on | Set to `0` on a real deployment. Otherwise four fictional colleagues appear in every new account's conversation list and in search — charming as a demo, odd for strangers signing up on your domain. |

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

**Running behind more than one worker.** Passenger (and any multi-instance
setup) runs several processes over one database, each with its own memory. Two
things therefore live in SQLite rather than in a process: the **event bus**
(every worker appends events and tails the table, so a message sent through one
worker reaches a client connected to another) and **presence** (the SSE
heartbeat stamps `last_seen`, which any worker can read). Event ids come from an
AUTOINCREMENT column, so they are globally unique and an SSE `Last-Event-ID`
resume works even when the reconnect lands on a different worker. Rate limits
are shared for the same reason — counted per process, every limit is silently
multiplied by the size of the pool.

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

### Encryption at rest

Off by default, on with one setting:

```bash
npm run encrypt -- --key          # generates a key to put in the environment
npm run encrypt                   # encrypts what is already there
```

Message bodies, unsent drafts, reported-message snapshots, report notes,
feedback and appeals are encrypted with **AES-256-GCM**, a fresh IV per value.
`npm run encrypt -- --status` counts what is stored which way, and `--off`
converts back.

**What this protects against, precisely:** somebody who obtains the database
file but not the server — a copied backup, a misconfigured document root serving
`data/relay.db`, a decommissioned disk. **What it does not:** anyone who can run
code on the server or read its environment has the key by definition. It is not
end-to-end encryption and the code says so where you would look for it.

Three details worth knowing, each of which was a bug first:

- **The event bus is covered too.** Published events are persisted so other
  worker processes can pick them up, and a message event carries the body —
  encrypting `messages.text` while writing the same words there as plain JSON
  left them in the file anyway. A grep of a real database is what found it, and a
  test now greps the `events` table for a canary.
- **`PRAGMA secure_delete` is on, and the migration ends with `VACUUM`.**
  Rewriting a row leaves the old bytes in a free page, so without this the
  plaintext the migration replaced stayed readable in the file.
- **The marker that distinguishes encrypted values from plaintext starts with a
  control character**, and every text input strips control characters — so it is
  a marker no user can forge. A printable marker meant a message beginning with
  it was stored unencrypted and then read back as undecryptable. It is not NUL,
  which was the obvious pick: `node:sqlite` truncates a string at the first NUL,
  which would have silently emptied every message.

Existing plaintext rows keep working, since the marker is per value — a
half-finished migration is readable rather than half-broken, and re-running it
is a no-op. Search still works with encryption on, by decrypting the most recent
5,000 messages and matching in memory rather than in SQL; that is slower than the
index it replaces, and bounded so it cannot be made to run indefinitely.

**If you lose the key, the messages are gone.** There is no recovery path, which
is the same property that makes a copied database file useless.

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

**Notifications reach you with the app closed.** Relay is installable, and
turning notifications on registers the device for Web Push — VAPID signing and
RFC 8291 payload encryption, so the push service relays a body it cannot read.
Tapping a notification focuses an open tab rather than launching a duplicate.

New accounts are **asked once**, by a bar under the top bar, because a setting
nobody finds is a setting nobody turns on. The button is what triggers the
browser's own permission dialog — some platforms only allow that from inside a
user gesture — and "Not now" is remembered per device. It is not shown when the
browser has already decided: `granted` needs nothing, and `denied` cannot be
undone from a web page, only in site settings, so the copy says that instead of
offering a button that would do nothing. On iPhone and iPad it explains that
Relay has to be added to the home screen first, since Safari only exposes
notifications to an installed app.

Notifications make a sound. They previously did not — `silent: true` was set on
every one, which is the wrong default for the thing people want from a
notification. Only one sound plays: the in-app chime is skipped whenever the
system notification fires. The chime also needed unblocking, since browsers
create an `AudioContext` suspended and only allow it to start from a user
gesture, so it silently did nothing until you happened to click something. Messages you send with no connection are held in an outbox that
survives a reload and flushes when the network returns.

Live delivery with distinct status icons (sending, sent ✓, delivered ✓✓, read),
typing indicators, read receipts you can switch off (the server then withholds
them from others while still tracking your own unread count), emoji reactions,
replies with quoting, editing, deleting, per-conversation drafts, pinning,
muting, unread badges and dividers, groups, message formatting
(`**bold**`, `*italic*`, `` `code` ``, auto-links), day separators, and JSON
export of everything the server holds about you.

**The emoji picker** holds 400-odd characters across six categories, searchable
by the words you would actually type — "thanks" finds 🙏, "fire" finds 🔥 — and
remembers what you used. Search matches the *start* of a keyword rather than
anywhere inside one, because on a short query a substring match returns almost
everything, which is the same as returning nothing. The quick reaction row leads
with your recents and has a `＋` for the full set. Both the composer and the
reaction row open the same picker; it is one question asked twice.

**Finding people.** The sidebar carries a labelled **Find people** button, not
only a compose icon. A new account arrives with an empty list and no obvious
next step; an icon is discoverable to whoever already knows what it does.

Search covers conversations, **people** and full message history, with a
separate in-conversation search that cycles matches.

**Every account has a username** — `@ada_lovelace` — assigned from the display
name at sign-up (guests and pre-existing accounts included, so it is something
you can rely on) and changeable under **Settings → Profile**. It is 3–20
characters of letters, numbers and underscores, stored lowercase because case is
not identity: allowing both `@ben` and `@Ben` would make a handle useless for
finding somebody and an easy way to pass as them. Handles that address the
service itself — `admin`, `support`, `security` — are reserved.

**People search is a lookup, not a member list.** Nothing is sent to the server
until you have typed three characters, and the server independently refuses to
answer below that: a blank query returns nobody rather than the entire
directory. Below the threshold the dialog shows the people you already know —
your contacts and anyone you share a conversation with — all of which the
browser already had.

Matching is anchored rather than "contains anywhere":

| Field | Matches |
| --- | --- |
| Username | prefix — `ada` finds `@ada_lovelace`; a leading `@` is optional |
| Name | prefix of any word, so `smith` finds "John Smith" |
| Role | prefix of any word |
| Email | **exact address only** — knowing a domain, or half an address, finds nobody |

An exact handle sorts above everyone who merely starts the same, and typed `%`
or `_` are literal characters rather than SQL wildcards. An address is still
only *disclosed* to people you already share a conversation with or have as a
contact. Anyone you can find you can add to **contacts**, which get their own
sidebar tab and sort to the top of search.

**Profile photos.** Any account can upload one. The browser crops a centred
square and downscales it before sending, so a 4000px camera photo does not cost
everyone who ever sees it — and no image library is needed on the server, which
keeps the no-dependencies promise. PNG, JPEG or WebP up to 2 MB after resizing.

The type is **sniffed from the bytes**, never taken from the request: an SVG
renamed `.png` is refused, because an SVG is a document that can carry script and
avatars render inline in a hundred places. Photos need a session to fetch — a
profile photo is not secret among users, but it is not for the open internet to
scrape either. Each upload gets a fresh URL stamped with its timestamp, so the
image can be cached immutably and a changed photo still appears at once. Initials
stay underneath as the fallback, so a photo that fails to load leaves something
legible rather than an empty circle.

**Last online.** "Offline" tells you nothing useful; "last seen 20 minutes ago"
tells you whether waiting for a reply is reasonable, so that is what the
conversation header and profile card show. It is **yours to switch off** —
Settings → Profile — and when it is off, others see only whether you are online
right now. Presence and history are separate questions: hiding when you were
last here does not cost the live "online now" dot that makes a conversation feel
alive.

**Mentions.** `@handle` lights up when it belongs to somebody in that
conversation, and more strongly when it is you. Only real members are marked, so
an `@` in ordinary prose — or an email address — stays ordinary text. Being
named reaches you **through a mute**: you muted the conversation, not a direct
request for your attention.

**Profiles.** Every account has one: display name, username, pronouns, role, a short bio,
an avatar colour, a time zone, and a status with an emoji that can expire on its
own after 30 minutes, an hour, four hours, or at the end of the day. Open anyone
by clicking their name or avatar in a conversation header, or their avatar
beside a message; open your own from the account menu. A profile shows their
availability or when they were last seen, their local time so you know whether
they are awake, groups you have in common, and buttons to message them or add
them as a contact. You edit your own under **Settings → Profile**, with a live
preview of the card other people will see.

**Blocking and reporting.** Any profile card carries a Safety row, and any
message somebody else sent carries a Report action that quotes it.

Blocking is **mutual and enforced server-side on every route**, not just on
send. The direct conversation leaves both snapshots, its history stops loading,
both names drop out of people search, their messages drop out of message search,
push is suppressed, and neither side can reopen the thread. Nothing is deleted —
unblocking restores the conversation and every message in it. Shared groups are
deliberately untouched: blocking is a direct-message tool, not a way to silence
someone in a room you both belong to.

The block is not disclosed to the person blocked. Refusals reuse the same
message a stranger would get, their profile request 404s exactly as a deleted
account would, and the live nudge that tells their client to redraw carries an
empty payload. Because a blocked account then disappears everywhere, the
**Settings → Data & privacy** panel lists who you have blocked and is the way
to undo it.

Reports capture a reason, an optional note, and a *snapshot* of the reported
message, so evidence survives the sender deleting it. You cannot cite a message
from a conversation you are not in. They are reviewed on the moderation
dashboard below, or from the command line with `npm run reports`.

## Moderation dashboard

A separate page at `/admin`: the report queue, user feedback, an instance
overview, and the administrator audit log. Grant access from a shell on the
server —

```bash
npm run admin -- --grant you@example.com
```

`npm run admin` lists administrators and `--revoke` takes it away. Setting
`RELAY_ADMIN_EMAIL` marks an account on boot, which is the convenient form for a
container or a Passenger app.

**To everybody else the dashboard does not exist.** Not "forbidden" — absent.
Each response is byte-for-byte what the same shape of unknown path returns:
`/admin` gives the ordinary app shell, exactly as `/some-typo` does, because the
app routes on the client; `/admin/admin.js` gives the same 404 as any other
missing file; and every `/api/admin/*` route answers with the router's own
`Unknown endpoint.` A 401 or a 403 would confirm there is something there worth
attacking, so neither is ever used. Nothing in `index.html` or `ui.js` — both
served to anyone — mentions the page, and the path itself is only sent to
accounts that hold the flag.

**Nothing reachable over HTTP can confer the flag.** No route in the app writes
`users.is_admin`; it comes from the CLI or the environment, both of which need
access to the server. A stolen session, an administrator's included, cannot
create a second administrator. Guest sessions are refused outright, since anyone
can obtain one. The flag is re-read from the database on every request, so
revoking it takes effect immediately rather than whenever that session expires.

Who *is* an administrator is not public either: the flag appears only on your
own account, never in search results, profile cards or the cached user list.

**Every action is logged** — actor, action, target, the status transition, IP and
time — along with each time the dashboard was opened. The log is append-only:
nothing in Relay edits or deletes a row, and it survives the administrator's
account being deleted. Refused attempts write nothing, so the trail is
administrator actions rather than an attack log.

The page is served with `default-src 'none'` and no inline script or style, no
external origin, `frame-ancestors 'none'`, `no-store` caching, and `noindex`. The
service worker skips it entirely — a report queue has no business in a disk
cache. Its client builds every node and sets `textContent`, never `innerHTML`,
because the strings on that screen are written by the person being reported.

**Appeals.** A suspended account is not simply shut out. The sign-in screen
offers to have the decision looked at again, and one message goes to the
dashboard's Appeals tab, shown beside the reason they were given.

That endpoint is the only one in the app that checks a password outside sign-in,
because a suspended person has no session to authenticate with — so it is
careful not to become anything else. A wrong password and an unknown address
answer identically to each other and to a failed sign-in, so it cannot be used
to find out which addresses exist or which are suspended. It is rate limited like
the login route, it issues no session, and the limit of one appeal per suspension
is a rule rather than a throttle: the table's primary key is
`(user_id, suspended_at)`, so the queue cannot be flooded by the account it is
about. A *new* suspension is a new thing to appeal.

**Dashboard settings** live behind the cog, and belong to one administrator in
one browser — nothing there is sent to the server, because these are preferences
about somebody's own screen.

- **Accent colour** on three RGB sliders, with the contrast ratio against the
  panel behind it shown live and labelled *passes AA* / *fine for borders* /
  *hard to read*. The accent is used for text and for button fills, so a colour
  that looks pleasant can still be unreadable; saying so beats letting somebody
  pick a pale yellow and wonder where the tab labels went.
- **Light, dark or follow the system**, which keeps following it as it changes.
- **Auto-refresh** the queue, or only on request. It pauses while a dialog is
  open — pulling the list out from under somebody mid-decision is worse than a
  stale count.
- **Which tab opens first**, exact times instead of "2 hours ago", and compact
  rows.
- **Hide reported message text until clicked.** Whoever reads this queue did not
  choose to be sent the contents of it. One click costs nothing and means an
  abusive message is not the first thing on screen when the page loads. Clicking
  the revealed text puts it away again — the same spot, both directions, so you
  are not stuck looking at something once you have read it.

**Suspension** is the enforcement lever, offered on the report card itself so
reading a report and acting on it are the same screen. Pick 24 hours, 7 days,
30 days or open-ended, and write a reason.

A suspended account has no way in. Every device is signed out immediately — the
session rows are deleted, not merely rejected — and password, one-time email
code, quick-unlock PIN and passkey are all refused, because the check sits in the
one place every sign-in method passes through rather than in each of them. The
live event stream is refused too, and a suspension written straight into the
database by hand is honoured just the same.

**Unlike a block, it is told to the person.** A block is undetectable on purpose,
because it is one user's private choice about another; being locked out of your
own account by the operator is something you are owed an explanation for, and a
vague failure only produces a support request that has to give the same answer.
So the sign-in screen states it plainly, with the reason and the end date.

Nothing is deleted. What they already said stays in other people's conversations
— suspension stops someone participating, it does not rewrite history — and their
credentials are untouched, ready for the suspension to lift. They do drop out of
people search, and opening a new conversation with them is refused, since a
thread with someone who cannot answer is a dead end.

A timed suspension **lapses on its own**. There is no sweeper: the state is
computed from the row, so a server that was switched off over the weekend does
not hold somebody out for longer than they were told.

Administrators cannot suspend themselves — that would lock them out of the tool
that undoes it — and cannot suspend each other. Removing another
administrator's access is a shell operation (`npm run admin -- --revoke`), which
keeps this from being a way for one administrator to shut the others out.
Suspending and lifting are both audited with the reason and the length.

**Feedback.** *Send feedback* in the account menu opens a short form — what kind
(an idea, something broken, hard to use, praise, something else) and what
happened. It arrives in the dashboard's Feedback tab, where it moves through
new → read → planned → done or declined, each change audited like any other
administrator action.

Only the sender's display name is attached, so an administrator can reply. No
user agent, no screen size, nothing about their conversations — a bug report is
worth less without a browser string, and asking for one is a better trade than
quietly collecting it. The name is copied into the row rather than only
referenced, so an idea outlives the account that had it; the dashboard then says
the account has since been deleted rather than showing a name that resolves to
nobody.

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

## Deliberate limits

Not gaps — decisions, with the reasoning, so you can disagree with them
knowingly.

- **No end-to-end encryption.** At-rest encryption protects the database file;
  the server still decrypts in order to render and to search. Real end-to-end
  encryption is a different product: it would remove server-side message search
  entirely and needs cross-device key management and key verification. Saying
  "encrypted" and meaning at-rest would be the dishonest version, so the section
  above spells out which one this is.
- **Attachment files are not encrypted.** They live outside the database, and
  the key would have to be applied to a byte-range read to keep inline images
  and resumable downloads working. Protect `data/uploads/` with filesystem
  permissions; the encryption setting does not cover it and does not claim to.
- **Attestation is not validated.** Registration uses `attestation: 'none'`, so
  Relay verifies possession of the passkey but does not attest which
  authenticator model produced it — which is what almost every service does.
  Validating it only buys something if you intend to allow-list specific
  hardware, and would need certificate-chain parsing per attestation format.
- **No virus scanner is bundled.** Shipping one would end the no-dependencies
  promise, so `RELAY_SCAN_COMMAND` is a hook: point it at `clamscan` and a
  non-zero exit rejects the upload. Relay says so on start when it is unset
  rather than leaving a documented setting nobody looks for. Uploads are served
  inertly either way — sniffed type, forced download for anything but a short
  image allow-list, and a `sandbox` CSP.
- **One SQLite database.** WAL handles a busy small deployment comfortably, and
  presence and the event bus work across worker processes, but nothing here
  shards or replicates. That ceiling is the price of "clone it and start it";
  past it, you want a different storage layer, not a patch to this one.

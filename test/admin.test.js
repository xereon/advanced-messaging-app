// The moderation dashboard.
//
// Two properties are worth more than the rest of the feature, and most of this
// file is about them:
//
//   1. To anyone without the flag, none of it exists. Not "forbidden" — absent,
//      with the same status and body as a mistyped URL, so probing tells you
//      nothing about whether a dashboard is there or who can reach it.
//   2. Nothing reachable over HTTP can confer the flag. A stolen session,
//      including an administrator's, cannot create another administrator.

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { startTestServer, signUp, client } from './helpers.js';
import * as db from '../server/db.js';

let srv;
before(async () => { srv = await startTestServer(); });
after(async () => { await srv.stop(); });

const makeAdmin = (userId) =>
  db.handle().prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(userId);

/** An administrator, an ordinary user, and a report between them. */
async function scene(tag) {
  const boss = await signUp(srv.base, `Boss ${tag}`, `boss.${tag}@admin.test`);
  const user = await signUp(srv.base, `User ${tag}`, `user.${tag}@admin.test`);
  const rogue = await signUp(srv.base, `Rogue ${tag}`, `rogue.${tag}@admin.test`);

  const convo = await user.client.post('/api/conversations', { type: 'dm', members: [rogue.user.id] });
  const msg = await rogue.client.post(
    `/api/conversations/${convo.body.conversation.id}/messages`, { text: 'buy my coins' },
  );
  const report = await user.client.post('/api/reports', {
    subjectId: rogue.user.id, convoId: convo.body.conversation.id,
    messageId: msg.body.message.id, reason: 'spam', note: 'every day this week',
  });

  makeAdmin(boss.user.id);
  return { boss, user, rogue, reportId: report.body.id };
}

/* ---------- the gate ---------- */

describe('the dashboard does not exist for anyone else', () => {
  const ADMIN_API = [
    ['GET', '/api/admin/overview'],
    ['GET', '/api/admin/reports'],
    ['GET', '/api/admin/audit'],
    ['GET', '/api/admin/anything-else'],
  ];

  test('an ordinary account gets 404, with the router\'s own error body', async () => {
    const { client: c } = await signUp(srv.base, 'Plain User', 'plain@admin.test');
    // What a genuinely unknown endpoint says, for comparison.
    const control = await c.get('/api/no-such-endpoint-at-all');
    assert.equal(control.status, 404);

    for (const [method, path] of ADMIN_API) {
      const res = await c.get(path);
      assert.equal(res.status, 404, `${method} ${path} must 404`);
      assert.deepEqual(res.body, control.body,
        `${path} must answer exactly as an unknown path does`);
      assert.ok(!/admin|forbidden|permission/i.test(JSON.stringify(res.body)),
        'the refusal must not name what was refused');
    }
  });

  test('a signed-out caller gets the same 404, not a 401', async () => {
    const anon = client(srv.base);
    for (const [, path] of ADMIN_API) {
      const res = await anon.get(path);
      assert.equal(res.status, 404, `${path} must not answer 401 — that confirms it exists`);
    }
  });

  test('resolving a report is refused the same way', async () => {
    const { reportId, user } = await scene('patch');
    const res = await user.client.patch(`/api/admin/reports/${reportId}`, { status: 'dismissed' });
    assert.equal(res.status, 404);

    // And it did not happen.
    const row = db.handle().prepare('SELECT status FROM reports WHERE id = ?').get(reportId);
    assert.equal(row.status, 'open');
  });

  test('the dashboard page answers exactly as a comparable unknown path', async () => {
    const { client: c } = await signUp(srv.base, 'Page Prober', 'prober@admin.test');

    // The control has to match the *shape* of the path being probed. An
    // extensionless path gets the app shell, because the app does client-side
    // routing; a path with an extension gets a 404. Answering a flat 404 for
    // /admin while /anything-else returned the shell was itself the tell that
    // something lived there, which is how this was caught.
    const cases = [
      ['/admin', '/some-unknown-route'],
      ['/admin/', '/some-unknown-route/'],
      ['/admin/admin.js', '/js/no-such-file.js'],
      ['/admin/admin.css', '/css/no-such-file.css'],
    ];

    for (const [probe, control] of cases) {
      for (const cookie of [c.cookie, undefined]) {
        const headers = cookie ? { Cookie: cookie } : {};
        const [a, b] = await Promise.all([
          fetch(srv.base + probe, { headers }),
          fetch(srv.base + control, { headers }),
        ]);
        assert.equal(a.status, b.status,
          `${probe} must answer with the same status as ${control}`);
        assert.equal(await a.text(), await b.text(),
          `${probe} must answer byte-for-byte as ${control}`);
      }
    }
  });

  test('the app shell it falls back to carries no trace of the dashboard', async () => {
    const { client: c } = await signUp(srv.base, 'Source Reader', 'source@admin.test');
    const boot = await c.get('/api/bootstrap');
    assert.equal(boot.body.me.adminUrl, undefined,
      'an ordinary account is not told where the dashboard is');

    // Anyone can read these two files; neither may mention a moderation page.
    for (const asset of ['/index.html', '/js/ui.js']) {
      const body = await (await fetch(srv.base + asset)).text();
      assert.ok(!/\/admin/.test(body), `${asset} must not contain the dashboard path`);
    }
  });

  test('the page does not leak out of public/, where everything is served', async () => {
    // The gate is the only route to these files. If they were in public/ the
    // static handler would hand them to anyone who guessed the name.
    for (const guess of ['/admin.html', '/admin/index.html', '/admin-ui/index.html',
      '/server/admin-ui/index.html', '/dashboard.html', '/moderation.html']) {
      const res = await fetch(srv.base + guess);
      const body = await res.text();
      assert.ok(!/Moderation — Relay/.test(body), `${guess} must not serve the dashboard`);
    }
  });

  test('a guest cannot be an administrator, even with the flag set', async () => {
    const guest = client(srv.base);
    const created = await guest.post('/api/auth/guest');
    assert.equal(created.status, 201);

    // Force the flag on, which the CLI refuses to do and no route can do.
    makeAdmin(created.body.user.id);

    assert.equal((await guest.get('/api/admin/overview')).status, 404);
    const page = await fetch(`${srv.base}/admin`, { headers: { Cookie: guest.cookie } });
    const html = await page.text();
    assert.ok(!/Moderation — Relay/.test(html),
      'a session anyone can obtain must never reach moderation tooling');
    assert.match(html, /Relay — Enterprise Messaging/, 'they get the ordinary app, like any stranger');
  });

  test('revoking the flag takes effect on the next request', async () => {
    const { boss } = await scene('revoke');
    assert.equal((await boss.client.get('/api/admin/overview')).status, 200);

    db.handle().prepare('UPDATE users SET is_admin = 0 WHERE id = ?').run(boss.user.id);

    // The same session, unchanged. The flag is re-read per request rather than
    // captured when the session was created.
    assert.equal((await boss.client.get('/api/admin/overview')).status, 404);
  });
});

/* ---------- no escalation ---------- */

describe('nothing over HTTP can make you an administrator', () => {
  test('the profile endpoint ignores an is_admin in the patch', async () => {
    const me = await signUp(srv.base, 'Climber One', 'climb1@admin.test');
    for (const patch of [
      { isAdmin: true }, { is_admin: 1 }, { isAdmin: 1, name: 'Climber One' },
      { admin: true }, { role: 'admin' },
    ]) {
      const res = await me.client.patch('/api/profile', patch);
      assert.ok(res.status < 500, 'a junk field must not crash the endpoint');
      const row = db.handle().prepare('SELECT is_admin FROM users WHERE id = ?').get(me.user.id);
      assert.equal(row.is_admin, 0, `${JSON.stringify(patch)} must not confer admin`);
    }
    assert.equal((await me.client.get('/api/admin/overview')).status, 404);
  });

  test('settings and sign-up cannot smuggle it in either', async () => {
    const me = await signUp(srv.base, 'Climber Two', 'climb2@admin.test');
    await me.client.put('/api/settings', { settings: { isAdmin: true, is_admin: 1 } });
    assert.equal(db.handle().prepare('SELECT is_admin FROM users WHERE id = ?').get(me.user.id).is_admin, 0);

    const smuggled = await client(srv.base).post('/api/auth/signup', {
      name: 'Climber Three', email: 'climb3@admin.test', password: 'hunter2hunter',
      isAdmin: true, is_admin: 1,
    });
    assert.equal(smuggled.status, 201);
    assert.equal(
      db.handle().prepare('SELECT is_admin FROM users WHERE email = ?').get('climb3@admin.test').is_admin,
      0, 'sign-up must not honour an is_admin in the body',
    );
  });

  test('an administrator cannot promote anyone, including themselves', async () => {
    const { boss, user } = await scene('promote');
    // There is no route for it. Prove there is nothing that answers.
    for (const [method, path, body] of [
      ['post', '/api/admin/admins', { userId: user.user.id }],
      ['post', '/api/admins', { userId: user.user.id }],
      ['patch', `/api/admin/users/${user.user.id}`, { isAdmin: true }],
      ['patch', `/api/users/${user.user.id}`, { isAdmin: true }],
    ]) {
      const res = await boss.client[method](path, body);
      assert.ok(res.status === 404 || res.status === 405 || res.status === 403,
        `${method} ${path} must not be a promotion route (got ${res.status})`);
    }
    assert.equal(
      db.handle().prepare('SELECT is_admin FROM users WHERE id = ?').get(user.user.id).is_admin, 0,
    );
  });

  test('the source contains no HTTP route that writes the flag', () => {
    // A grep, deliberately. The property is "no route anywhere", which no
    // single request can demonstrate.
    for (const file of ['../server/api.js', '../server/auth.js', '../server/admin.js']) {
      const src = readFileSync(new URL(file, import.meta.url), 'utf8');
      assert.ok(!/UPDATE\s+users\s+SET[^;]*is_admin/i.test(src),
        `${file} must not write is_admin — that belongs to the CLI and the boot flag`);
    }
  });
});

/* ---------- what an administrator sees ---------- */

describe('who is an administrator is not public', () => {
  test('the flag is absent from search results and profiles', async () => {
    const { boss, user } = await scene('secret');

    const found = await user.client.get('/api/users?q=boss');
    const seen = found.body.users.find((u) => u.id === boss.user.id);
    assert.ok(seen, 'precondition: findable like anyone else');
    assert.equal(seen.isAdmin, undefined, 'search must not mark out administrators');

    const profile = await user.client.get(`/api/users/${boss.user.id}`);
    assert.equal(profile.body.user.isAdmin, undefined, 'nor must a profile card');

    const boot = await user.client.get('/api/bootstrap');
    for (const u of boot.body.users) {
      assert.equal(u.isAdmin, undefined, 'nor the cached user list');
    }
  });

  test('but you are told about your own flag, so the app can offer the link', async () => {
    const { boss } = await scene('selfflag');
    const boot = await boss.client.get('/api/bootstrap');
    assert.equal(boot.body.me.isAdmin, true);
    const me = await boss.client.get('/api/me');
    assert.equal(me.body.user.isAdmin, true);

    const plain = await signUp(srv.base, 'Not Admin', 'notadmin@admin.test');
    assert.equal((await plain.client.get('/api/bootstrap')).body.me.isAdmin, false);
  });
});

describe('the report queue', () => {
  test('lists reports with the context needed to judge one', async () => {
    const { boss, user, rogue, reportId } = await scene('queue');
    const res = await boss.client.get('/api/admin/reports');
    assert.equal(res.status, 200);

    const report = res.body.reports.find((r) => r.id === reportId);
    assert.ok(report, 'the open report is listed');
    assert.equal(report.reason, 'spam');
    assert.equal(report.note, 'every day this week');
    assert.equal(report.quotedMessage, 'buy my coins', 'the snapshot taken when filed');
    assert.equal(report.subject.id, rogue.user.id);
    assert.equal(report.subject.username, rogue.user.username);
    assert.equal(report.reporter.id, user.user.id);
    assert.equal(report.status, 'open');
  });

  test('counts the subject\'s other live reports, which is what marks a pattern', async () => {
    const { boss, rogue, reportId } = await scene('pattern');
    const second = await signUp(srv.base, 'Second Complainant', 'second@admin.test');
    await second.client.post('/api/reports', { subjectId: rogue.user.id, reason: 'harassment' });

    const res = await boss.client.get('/api/admin/reports');
    const report = res.body.reports.find((r) => r.id === reportId);
    assert.equal(report.subject.otherReports, 1, 'excluding this one');
  });

  test('filters by status, and "all" shows everything', async () => {
    const { boss, reportId } = await scene('filter');
    await boss.client.patch(`/api/admin/reports/${reportId}`, { status: 'dismissed' });

    const open = await boss.client.get('/api/admin/reports?status=open');
    assert.ok(!open.body.reports.some((r) => r.id === reportId));

    const dismissed = await boss.client.get('/api/admin/reports?status=dismissed');
    assert.ok(dismissed.body.reports.some((r) => r.id === reportId));

    const all = await boss.client.get('/api/admin/reports?status=all');
    assert.ok(all.body.reports.some((r) => r.id === reportId));
  });

  test('an unknown status is a 400, not a silent full listing', async () => {
    const { boss } = await scene('badstatus');
    assert.equal((await boss.client.get('/api/admin/reports?status=nonsense')).status, 400);
    assert.equal((await boss.client.patch('/api/admin/reports/r-x', { status: 'banned' })).status, 400);
  });

  test('resolving an unknown report is a 404, not a silent success', async () => {
    const { boss } = await scene('missing');
    assert.equal((await boss.client.patch('/api/admin/reports/r-nope', { status: 'reviewed' })).status, 404);
  });

  test('the queue never carries live conversation content', async () => {
    const { boss, user, rogue } = await scene('nocontent');
    // A second, unreported message in the same conversation.
    const convoId = `dm:${[user.user.id, rogue.user.id].sort().join('~')}`;
    await rogue.client.post(`/api/conversations/${convoId}/messages`, { text: 'UNREPORTED SECRET' });

    const res = await boss.client.get('/api/admin/reports?status=all');
    assert.ok(!JSON.stringify(res.body).includes('UNREPORTED SECRET'),
      'only the snapshot a reporter attached may appear');
  });
});

/* ---------- audit ---------- */

describe('the audit trail', () => {
  beforeEach(() => { db.handle().prepare('DELETE FROM admin_audit').run(); });

  test('resolving a report is recorded, with who, what and the transition', async () => {
    const { boss, reportId } = await scene('audit1');
    await boss.client.patch(`/api/admin/reports/${reportId}`, { status: 'actioned' });

    const { body } = await boss.client.get('/api/admin/audit');
    const entry = body.entries.find((e) => e.action === 'report.resolve');
    assert.ok(entry, 'the action is logged');
    assert.equal(entry.actor_id, boss.user.id);
    assert.equal(entry.actor_name, `Boss audit1`);
    assert.equal(entry.target_type, 'report');
    assert.equal(entry.target_id, reportId);
    assert.equal(entry.detail, 'open → actioned');
    assert.ok(entry.at > 0);
  });

  test('opening the dashboard is recorded, but its assets are not', async () => {
    const { boss } = await scene('audit2');
    await fetch(`${srv.base}/admin`, { headers: { Cookie: boss.client.cookie } });
    await fetch(`${srv.base}/admin/admin.js`, { headers: { Cookie: boss.client.cookie } });
    await fetch(`${srv.base}/admin/admin.css`, { headers: { Cookie: boss.client.cookie } });

    const { body } = await boss.client.get('/api/admin/audit');
    const opens = body.entries.filter((e) => e.action === 'dashboard.open');
    assert.equal(opens.length, 1, 'one entry per visit, not one per file');
  });

  test('a refused attempt writes nothing — the log is administrator actions only', async () => {
    const { user, reportId } = await scene('audit3');
    await user.client.patch(`/api/admin/reports/${reportId}`, { status: 'dismissed' });
    await fetch(`${srv.base}/admin`, { headers: { Cookie: user.client.cookie } });

    const rows = db.handle().prepare('SELECT COUNT(*) AS n FROM admin_audit').get().n;
    assert.equal(rows, 0);
  });

  test('the log survives the administrator\'s account being deleted', async () => {
    const { boss, reportId } = await scene('audit4');
    await boss.client.patch(`/api/admin/reports/${reportId}`, { status: 'reviewed' });
    await boss.client.del('/api/account');

    const entry = db.handle().prepare("SELECT * FROM admin_audit WHERE action = 'report.resolve'").get();
    assert.ok(entry, 'a moderation record must not vanish with the account that made it');
    assert.equal(entry.actor_name, 'Boss audit4');
  });

  test('the log is not readable by an ordinary account', async () => {
    const { boss, user, reportId } = await scene('audit5');
    await boss.client.patch(`/api/admin/reports/${reportId}`, { status: 'reviewed' });
    assert.equal((await user.client.get('/api/admin/audit')).status, 404);
  });
});

/* ---------- the page and its headers ---------- */

describe('the served page', () => {
  test('an administrator gets it, with headers that keep it out of caches', async () => {
    const { boss } = await scene('page');
    const res = await fetch(`${srv.base}/admin`, { headers: { Cookie: boss.client.cookie } });
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /Moderation — Relay/);

    assert.match(res.headers.get('cache-control'), /no-store/);
    assert.match(res.headers.get('cache-control'), /private/);
    assert.match(res.headers.get('x-robots-tag'), /noindex/);
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');

    const csp = res.headers.get('content-security-policy');
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /form-action 'none'/);
    assert.ok(!csp.includes('unsafe-inline'), 'no inline script or style may be allowed');
    assert.ok(!/https?:/.test(csp), 'no external origin may be allowed');
  });

  test('its script and stylesheet are served too, under the same gate', async () => {
    const { boss } = await scene('assets');
    for (const [path, type] of [['/admin/admin.js', /javascript/], ['/admin/admin.css', /css/]]) {
      const res = await fetch(srv.base + path, { headers: { Cookie: boss.client.cookie } });
      assert.equal(res.status, 200, `${path} must be served to an administrator`);
      assert.match(res.headers.get('content-type'), type);
    }
  });

  test('the page never interpolates report text into markup', () => {
    const src = readFileSync(new URL('../server/admin-ui/admin.js', import.meta.url), 'utf8');
    // Reported text is written by the person being reported. innerHTML with any
    // interpolation at all would be a stored-XSS hole aimed squarely at whoever
    // reviews the queue.
    assert.ok(!/innerHTML\s*[+]?=/.test(src),
      'the dashboard must build nodes and set textContent, never assign innerHTML');
  });

  test('the service worker leaves the dashboard alone', () => {
    const sw = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');
    assert.match(sw, /\/admin/,
      'the worker must skip /admin, or it caches the queue and clobbers the app shell');
  });
});

// admin.js — the moderation dashboard's client.
//
// Every render path builds nodes and assigns textContent. There is no innerHTML
// with interpolated data anywhere in this file, deliberately: the strings shown
// here are attacker-controlled by definition — a reported message is written by
// the person being reported, and a report note by whoever filed it. This is the
// one screen where hostile text is the normal case.

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

/* ---------- transport ---------- */

async function call(method, path, body) {
  const init = {
    method,
    credentials: 'same-origin',
    headers: { 'X-Relay-Client': '1' },
  };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(`/api${path}`, init);
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};

  // The API answers 404 for anyone without the flag, so a 404 here means the
  // session lost admin (revoked, signed out, expired) rather than a bad path.
  if (res.status === 404) {
    showBanner('This session is no longer an administrator. Sign in again, or ask for the flag to be restored.');
    throw new Error('Not available.');
  }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
  return data;
}

/* ---------- chrome ---------- */

function toast(message, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`.trim();
  el.textContent = message;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), 4000);
}

function showBanner(message) {
  const el = $('#banner');
  el.textContent = message;
  el.hidden = false;
}

const NUM = new Intl.NumberFormat();
const fmtNum = (n) => NUM.format(Number(n) || 0);

const DATE = new Intl.DateTimeFormat([], {
  year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
});
const fmtWhen = (ms) => (ms ? DATE.format(new Date(ms)) : '—');

/** "3 hours ago" — how fresh a report is matters more than its timestamp. */
function fmtAgo(ms) {
  if (!ms) return '';
  const mins = Math.round((Date.now() - ms) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

const REASON_LABEL = {
  spam: 'Spam or scam',
  harassment: 'Harassment',
  impersonation: 'Impersonation',
  inappropriate: 'Inappropriate',
  other: 'Other',
};

/* ---------- reports ---------- */

let status = 'open';

async function loadReports() {
  const list = $('#report-list');
  const { reports } = await call('GET', `/admin/reports?status=${encodeURIComponent(status)}`);
  list.replaceChildren();

  if (!reports.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = status === 'open'
      ? 'Nothing open. Everything filed has been dealt with.'
      : `No ${status === 'all' ? '' : status + ' '}reports.`;
    list.append(empty);
    return;
  }
  for (const report of reports) list.append(reportCard(report));
}

function tag(text, cls) {
  const el = document.createElement('span');
  el.className = `tag ${cls}`;
  el.textContent = text;
  return el;
}

function fact(term, value) {
  const wrap = document.createElement('div');
  const dt = document.createElement('dt');
  dt.textContent = term;
  const dd = document.createElement('dd');
  dd.textContent = value;
  wrap.append(dt, dd);
  return wrap;
}

function reportCard(report) {
  const card = document.createElement('article');
  card.className = 'report';
  card.dataset.reportId = report.id;

  const head = document.createElement('div');
  head.className = 'report-head';

  const who = document.createElement('div');
  who.className = 'report-who';
  const name = document.createElement('strong');
  // A deleted account still has reports against it; say so rather than "null".
  name.textContent = report.subject?.name || 'a deleted account';
  who.append(name);
  if (report.subject?.username) {
    const handle = document.createElement('span');
    handle.className = 'handle';
    handle.textContent = ` @${report.subject.username}`;
    who.append(handle);
  }
  const meta = document.createElement('div');
  meta.className = 'report-meta';
  meta.textContent = `Reported by ${report.reporter?.name || 'a deleted account'} · ${fmtAgo(report.createdAt)}`;
  who.append(meta);

  const tags = document.createElement('div');
  tags.style.display = 'flex';
  tags.style.gap = '0.35rem';
  tags.style.flexWrap = 'wrap';
  tags.append(
    tag(REASON_LABEL[report.reason] || report.reason, 'reason'),
    tag(report.status, `status-${report.status}`),
  );
  const others = report.subject?.otherReports || 0;
  if (others > 0) {
    // The single most useful thing on the card: one complaint is an incident,
    // several about the same person is a pattern.
    tags.append(tag(`${others} more`, 'repeat'));
  }
  head.append(who, tags);
  card.append(head);

  if (report.note) {
    const note = document.createElement('p');
    note.className = 'report-note';
    note.textContent = report.note;
    card.append(note);
  }

  if (report.quotedMessage) {
    const quote = document.createElement('blockquote');
    quote.className = 'report-quote';
    const label = document.createElement('span');
    label.className = 'quote-label';
    label.textContent = 'Reported message, as it was when filed';
    const text = document.createElement('span');
    text.textContent = report.quotedMessage;
    quote.append(label, text);
    card.append(quote);
  }

  const facts = document.createElement('dl');
  facts.className = 'report-facts';
  facts.append(fact('Filed', fmtWhen(report.createdAt)));
  if (report.subject?.joined) facts.append(fact('Account created', fmtWhen(report.subject.joined)));
  if (report.subject?.isGuest) facts.append(fact('Account type', 'Guest'));
  if (report.subject?.email) facts.append(fact('Email', report.subject.email));
  facts.append(fact('Report id', report.id));
  card.append(facts);

  card.append(actionsFor(report));
  return card;
}

const NEXT_STATUS = [
  { to: 'reviewed', label: 'Mark reviewed' },
  { to: 'actioned', label: 'Mark actioned', primary: true },
  { to: 'dismissed', label: 'Dismiss' },
  { to: 'open', label: 'Reopen' },
];

function actionsFor(report) {
  const row = document.createElement('div');
  row.className = 'report-actions';
  for (const option of NEXT_STATUS) {
    if (option.to === report.status) continue;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `btn sm${option.primary ? ' primary' : ''}`;
    btn.textContent = option.label;
    btn.addEventListener('click', async () => {
      for (const b of row.querySelectorAll('button')) b.disabled = true;
      try {
        await call('PATCH', `/admin/reports/${encodeURIComponent(report.id)}`, { status: option.to });
        toast(`Report marked ${option.to}.`, 'ok');
        await Promise.all([loadReports(), loadCounts()]);
      } catch (err) {
        toast(err.message, 'error');
        for (const b of row.querySelectorAll('button')) b.disabled = false;
      }
    });
    row.append(btn);
  }
  return row;
}

/* ---------- feedback ---------- */

let fbStatus = 'new';

const KIND_LABEL = {
  idea: 'Idea or request',
  bug: 'Something broken',
  accessibility: 'Hard to use',
  praise: 'Praise',
  other: 'Other',
};

const FB_NEXT = [
  { to: 'read', label: 'Mark read' },
  { to: 'planned', label: 'Planned', primary: true },
  { to: 'done', label: 'Done' },
  { to: 'declined', label: 'Decline' },
  { to: 'new', label: 'Back to new' },
];

async function loadFeedback() {
  const list = $('#feedback-list');
  const { feedback } = await call('GET', `/admin/feedback?status=${encodeURIComponent(fbStatus)}`);
  list.replaceChildren();

  if (!feedback.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = fbStatus === 'new'
      ? 'No new feedback.'
      : `No ${fbStatus === 'all' ? '' : fbStatus + ' '}feedback.`;
    list.append(empty);
    return;
  }
  for (const item of feedback) list.append(feedbackCard(item));
}

function feedbackCard(item) {
  const card = document.createElement('article');
  card.className = 'report';

  const head = document.createElement('div');
  head.className = 'report-head';

  const who = document.createElement('div');
  who.className = 'report-who';
  const name = document.createElement('strong');
  name.textContent = item.author.name || 'someone';
  who.append(name);
  if (item.author.username && !item.author.deleted) {
    const handle = document.createElement('span');
    handle.className = 'handle';
    handle.textContent = ` @${item.author.username}`;
    who.append(handle);
  }
  const meta = document.createElement('div');
  meta.className = 'report-meta';
  // Say the account is gone rather than showing a name that resolves to nobody.
  meta.textContent = item.author.deleted
    ? `Account since deleted · ${fmtAgo(item.createdAt)}`
    : `${item.author.email || 'no email'} · ${fmtAgo(item.createdAt)}`;
  who.append(meta);

  const tags = document.createElement('div');
  tags.style.display = 'flex';
  tags.style.gap = '0.35rem';
  tags.style.flexWrap = 'wrap';
  tags.append(
    tag(KIND_LABEL[item.kind] || item.kind, 'reason'),
    tag(item.status, `status-${item.status === 'new' ? 'open' : 'reviewed'}`),
  );
  head.append(who, tags);
  card.append(head);

  const body = document.createElement('p');
  body.className = 'report-note';
  body.style.whiteSpace = 'pre-wrap';
  body.textContent = item.message;
  card.append(body);

  const facts = document.createElement('dl');
  facts.className = 'report-facts';
  facts.append(fact('Sent', fmtWhen(item.createdAt)), fact('Id', item.id));
  card.append(facts);

  const row = document.createElement('div');
  row.className = 'report-actions';
  for (const option of FB_NEXT) {
    if (option.to === item.status) continue;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `btn sm${option.primary ? ' primary' : ''}`;
    btn.textContent = option.label;
    btn.addEventListener('click', async () => {
      for (const b of row.querySelectorAll('button')) b.disabled = true;
      try {
        await call('PATCH', `/admin/feedback/${encodeURIComponent(item.id)}`, { status: option.to });
        toast(`Feedback marked ${option.to}.`, 'ok');
        await Promise.all([loadFeedback(), loadCounts()]);
      } catch (err) {
        toast(err.message, 'error');
        for (const b of row.querySelectorAll('button')) b.disabled = false;
      }
    });
    row.append(btn);
  }
  card.append(row);
  return card;
}

/* ---------- overview ---------- */

const GROUPS = [
  {
    key: 'reports',
    title: 'Reports',
    stats: [
      ['open', 'Open', true],
      ['lastDay', 'Filed today'],
      ['reviewed', 'Reviewed'],
      ['actioned', 'Actioned'],
      ['dismissed', 'Dismissed'],
    ],
  },
  {
    key: 'feedback',
    title: 'Feedback',
    stats: [
      ['unread', 'New', true],
      ['lastWeek', 'This week'],
      ['total', 'All time'],
    ],
  },
  {
    key: 'accounts',
    title: 'Accounts',
    stats: [
      ['registered', 'Registered'],
      ['guests', 'Guests signed in'],
      ['activeToday', 'Seen today'],
      ['newThisWeek', 'New this week'],
      ['admins', 'Administrators'],
    ],
  },
  {
    key: 'activity',
    title: 'Activity',
    stats: [
      ['conversations', 'Conversations'],
      ['messages', 'Messages'],
      ['messagesToday', 'Messages today'],
      ['attachments', 'Attachments'],
      ['blocks', 'Blocks in force'],
      ['pushSubscriptions', 'Push devices'],
    ],
  },
];

async function loadOverview() {
  const data = await call('GET', '/admin/overview');
  const grid = $('#overview-grid');
  grid.replaceChildren();

  for (const group of GROUPS) {
    const section = document.createElement('section');
    section.className = 'stat-group';
    const h = document.createElement('h2');
    h.textContent = group.title;
    section.append(h);

    const inner = document.createElement('div');
    inner.className = 'stat-grid';
    for (const [key, label, alertWhenAny] of group.stats) {
      const value = data[group.key]?.[key] ?? 0;
      const box = document.createElement('div');
      box.className = 'stat' + (alertWhenAny && value > 0 ? ' alert' : '');
      const n = document.createElement('span');
      n.className = 'n';
      n.textContent = fmtNum(value);
      const k = document.createElement('span');
      k.className = 'k';
      k.textContent = label;
      box.append(n, k);
      inner.append(box);
    }
    section.append(inner);
    grid.append(section);
  }
}

/** The tab badges. One request feeds both. */
async function loadCounts() {
  try {
    const { reports, feedback } = await call('GET', '/admin/overview');
    for (const [sel, n] of [['#open-count', reports.open], ['#feedback-count', feedback.unread]]) {
      const pill = $(sel);
      pill.textContent = fmtNum(n);
      pill.hidden = !n;
    }
  } catch { /* the banner has already said why */ }
}

/* ---------- audit ---------- */

async function loadAudit() {
  const { entries } = await call('GET', '/admin/audit?limit=200');
  const body = $('#audit-rows');
  body.replaceChildren();

  if (!entries.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 6;
    td.textContent = 'Nothing logged yet.';
    td.style.color = 'var(--text-3)';
    tr.append(td);
    body.append(tr);
    return;
  }

  for (const entry of entries) {
    const tr = document.createElement('tr');
    const cells = [
      fmtWhen(entry.at),
      entry.actor_name || entry.actor_id || 'unknown',
      entry.action,
      entry.target_id ? `${entry.target_type || ''} ${entry.target_id}`.trim() : '—',
      entry.detail || '—',
      entry.ip || '—',
    ];
    cells.forEach((value, i) => {
      const td = document.createElement('td');
      if (i === 4) td.className = 'detail';
      if (i === 2 || i === 3) {
        const code = document.createElement('code');
        code.textContent = value;
        td.append(code);
      } else {
        td.textContent = value;
      }
      tr.append(td);
    });
    body.append(tr);
  }
}

/* ---------- tabs ---------- */

const LOADERS = { queue: loadReports, feedback: loadFeedback, overview: loadOverview, audit: loadAudit };
let tab = 'queue';

async function show(next) {
  tab = next;
  for (const btn of $$('.tab')) {
    btn.setAttribute('aria-current', String(btn.dataset.tab === next));
  }
  for (const panel of $$('.panel')) {
    panel.hidden = panel.dataset.panel !== next;
  }
  await refresh();
}

async function refresh() {
  const btn = $('#btn-refresh');
  btn.disabled = true;
  try {
    await LOADERS[tab]();
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

/* ---------- start ---------- */

async function start() {
  for (const btn of $$('.tab')) {
    btn.addEventListener('click', () => show(btn.dataset.tab));
  }
  // Each panel has its own filter row, so a chip only touches its own siblings.
  for (const chip of $$('.chip')) {
    chip.addEventListener('click', async () => {
      if (chip.dataset.status) status = chip.dataset.status;
      else fbStatus = chip.dataset.fbStatus;
      for (const sibling of chip.parentElement.querySelectorAll('.chip')) {
        sibling.setAttribute('aria-pressed', String(sibling === chip));
      }
      await refresh();
    });
  }
  $('#btn-refresh').addEventListener('click', refresh);

  try {
    const { user } = await call('GET', '/me');
    $('#whoami').textContent = `${user.name} · administrator`;
  } catch { /* the banner covers it */ }

  await Promise.all([refresh(), loadCounts()]);
}

start();

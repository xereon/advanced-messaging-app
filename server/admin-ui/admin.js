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
  // Some people would rather read a clock than do the arithmetic themselves.
  if (settings.absoluteTimes) return fmtWhen(ms);
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
    card.append(quotedBlock(report.quotedMessage));
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

/**
 * The reported message, optionally behind a click.
 *
 * Whoever reads this queue did not choose to be sent the content in it. Hiding
 * it until asked costs one click and means an abusive message is not the first
 * thing on screen when the page loads.
 */
function quotedBlock(text) {
  const quote = document.createElement('blockquote');
  quote.className = 'report-quote';
  const label = document.createElement('span');
  label.className = 'quote-label';
  label.textContent = 'Reported message, as it was when filed';
  quote.append(label);

  if (!settings.blurReported) {
    const body = document.createElement('span');
    body.textContent = text;
    quote.append(body);
    return quote;
  }

  // One button that toggles, rather than a button that is consumed. Having read
  // something unpleasant you should be able to put it away again in the same
  // place you opened it, without reloading the queue.
  const closedLabel = `Show the reported message (${text.length} character${text.length === 1 ? '' : 's'})`;
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'reveal';
  let shown = false;

  const paint = () => {
    toggle.textContent = shown ? text : closedLabel;
    toggle.classList.toggle('revealed', shown);
    toggle.setAttribute('aria-expanded', String(shown));
    toggle.title = shown ? 'Hide this again' : 'Show the reported message';
  };
  paint();
  toggle.addEventListener('click', () => { shown = !shown; paint(); });

  quote.append(toggle);
  return quote;
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

  // The point of reading a report is being able to do something about it, so the
  // lever sits on the card rather than on another screen.
  if (report.subject?.id && !report.subject.suspended) {
    const suspend = document.createElement('button');
    suspend.type = 'button';
    suspend.className = 'btn sm danger';
    suspend.textContent = 'Suspend…';
    suspend.addEventListener('click', () => openSuspend(report.subject));
    row.append(suspend);
  } else if (report.subject?.suspended) {
    const already = document.createElement('span');
    already.className = 'tag status-actioned';
    already.style.alignSelf = 'center';
    already.textContent = 'suspended';
    row.append(already);
  }

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

/* ---------- suspension ---------- */

let suspendTarget = null;

/**
 * Ask before suspending, with the duration and the reason in one place.
 *
 * The reason is not optional in spirit — it is what the person reads when they
 * cannot get in — so the field says who it is written for.
 */
function openSuspend(user) {
  suspendTarget = user;
  $('#suspend-who').textContent = `${user.name}${user.username ? ` (@${user.username})` : ''}`;
  $('#suspend-reason').value = '';
  const week = $('#suspend-form input[value="7"]');
  if (week) week.checked = true;
  const err = $('#suspend-error');
  err.hidden = true;
  err.textContent = '';
  $('#suspend-dialog').showModal();
  $('#suspend-reason').focus();
}

function wireSuspend() {
  $('#suspend-cancel').addEventListener('click', () => $('#suspend-dialog').close());

  $('#suspend-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!suspendTarget) return;
    const btn = $('#suspend-confirm');
    const err = $('#suspend-error');
    const days = $('#suspend-form input[name="suspend-days"]:checked')?.value ?? '';
    btn.disabled = true;
    try {
      await call('POST', `/admin/users/${encodeURIComponent(suspendTarget.id)}/suspension`, {
        days: days === '' ? null : Number(days),
        reason: $('#suspend-reason').value.trim(),
      });
      $('#suspend-dialog').close();
      toast(`${suspendTarget.name} is suspended.`, 'ok');
      await Promise.all([refresh(), loadCounts()]);
    } catch (error) {
      err.textContent = error.message;
      err.hidden = false;
    } finally {
      btn.disabled = false;
    }
  });
}

async function unsuspend(user) {
  await call('DELETE', `/admin/users/${encodeURIComponent(user.id)}/suspension`);
  toast(`${user.name} can sign in again.`, 'ok');
  // Reflect the chosen tab in the chrome before loading it.
  for (const btn of $$('.tab')) btn.setAttribute('aria-current', String(btn.dataset.tab === tab));
  for (const panel of $$('.panel')) panel.hidden = panel.dataset.panel !== tab;

  await Promise.all([refresh(), loadCounts()]);
}

/* ---------- accounts ---------- */

// Filled in once /me answers, so our own row can say "you" instead of a
// suspend button the server would refuse anyway.
let myId = null;
let acctQuery = '';
let acctDebounce = null;

function wireAccountSearch() {
  const input = $('#account-search');
  input.addEventListener('input', () => {
    acctQuery = input.value;
    clearTimeout(acctDebounce);
    // Long enough that a fast typist does not fire one request per letter,
    // short enough that the list still feels like it is following along.
    acctDebounce = setTimeout(() => { if (tab === 'accounts') loadAccounts(); }, 300);
  });
}

function accountCard(account) {
  const card = document.createElement('article');
  card.className = 'report';

  const head = document.createElement('div');
  head.className = 'report-head';
  const who = document.createElement('div');
  who.className = 'report-who';
  const name = document.createElement('strong');
  name.textContent = account.name;
  who.append(name);
  if (account.username) {
    const handle = document.createElement('span');
    handle.className = 'handle';
    handle.textContent = ` @${account.username}`;
    who.append(handle);
  }
  const meta = document.createElement('div');
  meta.className = 'report-meta';
  meta.textContent = `${account.email || 'guest'} · joined ${fmtAgo(account.createdAt)}`
    + (account.lastSeen ? ` · last seen ${fmtAgo(account.lastSeen)}` : '');
  who.append(meta);
  head.append(who);

  const tags = document.createElement('div');
  if (account.id === myId) {
    const tag = document.createElement('span');
    tag.className = 'tag status-reviewed';
    tag.textContent = 'you';
    tags.append(tag);
  }
  if (account.isAdmin) {
    const tag = document.createElement('span');
    tag.className = 'tag status-reviewed';
    tag.textContent = 'administrator';
    tags.append(tag);
  }
  if (account.isGuest) {
    const tag = document.createElement('span');
    tag.className = 'tag status-dismissed';
    tag.textContent = 'guest';
    tags.append(tag);
  }
  if (account.suspended) {
    const tag = document.createElement('span');
    tag.className = 'tag status-actioned';
    tag.textContent = account.suspension?.until ? `suspended until ${fmtWhen(account.suspension.until)}` : 'suspended';
    tags.append(tag);
  }
  if (account.openReports > 0) {
    const tag = document.createElement('span');
    tag.className = 'tag repeat';
    tag.textContent = `${account.openReports} open report${account.openReports === 1 ? '' : 's'}`;
    tags.append(tag);
  }
  if (tags.children.length) head.append(tags);
  card.append(head);

  if (account.suspension?.reason) {
    const reason = document.createElement('p');
    reason.className = 'report-note';
    reason.textContent = account.suspension.reason;
    card.append(reason);
  }

  // Nothing to do to your own account or another administrator's from here —
  // the server would refuse both, so the button is not offered in the first
  // place rather than shown and then failing.
  if (account.id !== myId && !account.isAdmin) {
    const row = document.createElement('div');
    row.className = 'report-actions';
    if (account.suspended) {
      const lift = document.createElement('button');
      lift.type = 'button';
      lift.className = 'btn sm primary';
      lift.textContent = 'Lift suspension';
      lift.addEventListener('click', async () => {
        lift.disabled = true;
        try { await unsuspend(account); }
        catch (err) { toast(err.message, 'error'); lift.disabled = false; }
      });
      row.append(lift);
    } else {
      const suspend = document.createElement('button');
      suspend.type = 'button';
      suspend.className = 'btn sm danger';
      suspend.textContent = 'Suspend…';
      suspend.addEventListener('click', () => openSuspend(account));
      row.append(suspend);
    }
    card.append(row);
  }

  return card;
}

async function loadAccounts() {
  const list = $('#accounts-list');
  const { accounts } = await call('GET', `/admin/accounts?q=${encodeURIComponent(acctQuery)}`);
  list.replaceChildren();

  if (!accounts.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = acctQuery ? `No account matches "${acctQuery}".` : 'No accounts yet.';
    list.append(empty);
    return;
  }
  for (const account of accounts) list.append(accountCard(account));
}

async function loadSuspended() {
  const list = $('#suspended-list');
  const { suspended } = await call('GET', '/admin/suspended');
  list.replaceChildren();

  if (!suspended.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = 'Nobody is suspended.';
    list.append(empty);
    return;
  }

  for (const person of suspended) {
    const card = document.createElement('article');
    card.className = 'report';

    const head = document.createElement('div');
    head.className = 'report-head';
    const who = document.createElement('div');
    who.className = 'report-who';
    const name = document.createElement('strong');
    name.textContent = person.name;
    who.append(name);
    if (person.username) {
      const handle = document.createElement('span');
      handle.className = 'handle';
      handle.textContent = ` @${person.username}`;
      who.append(handle);
    }
    const meta = document.createElement('div');
    meta.className = 'report-meta';
    meta.textContent = `${person.email || 'guest'} · suspended ${fmtAgo(person.at)}`;
    who.append(meta);

    const tags = document.createElement('div');
    const until = document.createElement('span');
    until.className = 'tag status-open';
    until.textContent = person.until ? `until ${fmtWhen(person.until)}` : 'no end date';
    tags.append(until);
    head.append(who, tags);
    card.append(head);

    if (person.reason) {
      const reason = document.createElement('p');
      reason.className = 'report-note';
      reason.textContent = person.reason;
      card.append(reason);
    }

    const facts = document.createElement('dl');
    facts.className = 'report-facts';
    facts.append(fact('Suspended', fmtWhen(person.at)));
    if (person.by) facts.append(fact('By', person.by));
    card.append(facts);

    const row = document.createElement('div');
    row.className = 'report-actions';
    const lift = document.createElement('button');
    lift.type = 'button';
    lift.className = 'btn sm primary';
    lift.textContent = 'Lift suspension';
    lift.addEventListener('click', async () => {
      lift.disabled = true;
      try { await unsuspend(person); }
      catch (err) { toast(err.message, 'error'); lift.disabled = false; }
    });
    row.append(lift);
    card.append(row);
    list.append(card);
  }
}

/* ---------- appeals ---------- */

const APPEAL_NEXT = [
  { to: 'read', label: 'Mark read' },
  { to: 'granted', label: 'Granted', primary: true },
  { to: 'refused', label: 'Refused' },
];

async function loadAppeals() {
  const list = $('#appeals-list');
  const { appeals } = await call('GET', '/admin/appeals?status=new');
  list.replaceChildren();

  if (!appeals.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = 'No appeals waiting.';
    list.append(empty);
    return;
  }

  for (const appeal of appeals) {
    const card = document.createElement('article');
    card.className = 'report';

    const head = document.createElement('div');
    head.className = 'report-head';
    const who = document.createElement('div');
    who.className = 'report-who';
    const name = document.createElement('strong');
    name.textContent = appeal.name;
    who.append(name);
    if (appeal.username) {
      const handle = document.createElement('span');
      handle.className = 'handle';
      handle.textContent = ` @${appeal.username}`;
      who.append(handle);
    }
    const meta = document.createElement('div');
    meta.className = 'report-meta';
    meta.textContent = `${appeal.email || 'no email'} · appealed ${fmtAgo(appeal.createdAt)}`;
    who.append(meta);

    const tags = document.createElement('div');
    // An appeal against a suspension that has since lapsed or been lifted is
    // still worth reading, but acting on it would be acting on nothing.
    tags.append(appeal.stillSuspended
      ? tag('still suspended', 'status-open')
      : tag('no longer suspended', 'status-dismissed'));
    head.append(who, tags);
    card.append(head);

    if (appeal.suspensionReason) {
      const quote = document.createElement('blockquote');
      quote.className = 'report-quote';
      const label = document.createElement('span');
      label.className = 'quote-label';
      label.textContent = 'The reason they were given';
      const text = document.createElement('span');
      text.textContent = appeal.suspensionReason;
      quote.append(label, text);
      card.append(quote);
    }

    const body = document.createElement('p');
    body.className = 'report-note';
    body.style.whiteSpace = 'pre-wrap';
    body.textContent = appeal.message;
    card.append(body);

    const facts = document.createElement('dl');
    facts.className = 'report-facts';
    facts.append(fact('Suspended', fmtWhen(appeal.suspendedAt)));
    if (appeal.suspendedUntil) facts.append(fact('Until', fmtWhen(appeal.suspendedUntil)));
    card.append(facts);

    const row = document.createElement('div');
    row.className = 'report-actions';
    for (const option of APPEAL_NEXT) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `btn sm${option.primary ? ' primary' : ''}`;
      btn.textContent = option.label;
      btn.addEventListener('click', async () => {
        for (const b of row.querySelectorAll('button')) b.disabled = true;
        try {
          await call(
            'PATCH',
            `/admin/appeals/${encodeURIComponent(appeal.userId)}/${appeal.suspendedAt}`,
            { status: option.to },
          );
          toast(`Appeal marked ${option.to}.`, 'ok');
          await Promise.all([loadAppeals(), loadCounts()]);
        } catch (err) {
          toast(err.message, 'error');
          for (const b of row.querySelectorAll('button')) b.disabled = false;
        }
      });
      row.append(btn);
    }
    card.append(row);
    list.append(card);
  }
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
      ['suspended', 'Suspended', true],
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
    const { reports, feedback, accounts, appeals } = await call('GET', '/admin/overview');
    for (const [sel, n] of [
      ['#open-count', reports.open],
      ['#feedback-count', feedback.unread],
      ['#suspended-count', accounts.suspended],
      ['#appeals-count', appeals.waiting],
    ]) {
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

const LOADERS = {
  queue: loadReports, accounts: loadAccounts, suspended: loadSuspended, appeals: loadAppeals,
  feedback: loadFeedback, overview: loadOverview, audit: loadAudit,
};
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
  // Before the first render, so nothing paints with the wrong accent and then
  // jumps, and so the chosen tab is the one that loads.
  loadSettings();
  applyScheme();
  applySettings();
  wireSettings();
  if (LOADERS[settings.tab]) tab = settings.tab;

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
  wireSuspend();
  wireAccountSearch();

  try {
    const { user } = await call('GET', '/me');
    $('#whoami').textContent = `${user.name} · administrator`;
    myId = user.id;
  } catch { /* the banner covers it */ }

  await Promise.all([refresh(), loadCounts()]);
}


/* ---------- dashboard settings ---------- */

// Kept in this browser, not on the server. These are one administrator's
// preferences about their own screen; storing them server-side would mean
// deciding whose win when two people share an account, for no benefit.
const SETTINGS_KEY = 'relay.admin.settings';

const DEFAULT_ACCENT = { light: [140, 42, 94], dark: [232, 121, 176] };

const DEFAULTS = {
  theme: 'auto',
  accent: null,        // null means "whatever the stylesheet says for this scheme"
  refresh: 0,          // seconds; 0 is manual
  tab: 'queue',
  absoluteTimes: false,
  compact: false,
  blurReported: false,
};

let settings = { ...DEFAULTS };

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) settings = { ...DEFAULTS, ...JSON.parse(raw) };
  } catch { settings = { ...DEFAULTS }; }
  return settings;
}

function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* private mode */ }
}

const prefersDark = () => window.matchMedia('(prefers-color-scheme: dark)').matches;
const effectiveDark = () => (settings.theme === 'auto' ? prefersDark() : settings.theme === 'dark');

/**
 * Relative luminance, for the contrast note beside the sliders.
 *
 * The accent is used for text and for button fills, so a colour that looks
 * pleasant can still be unreadable. Saying so is cheaper than letting somebody
 * pick a pale yellow and then wonder why the tab labels vanished.
 */
function luminance([r, g, b]) {
  const f = (v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function contrastAgainstSurface(rgb) {
  // The surface the accent sits on, per scheme, from the stylesheet.
  const surface = effectiveDark() ? [21, 26, 36] : [255, 255, 255];
  const [a, b] = [luminance(rgb), luminance(surface)].sort((x, y) => y - x);
  return (a + 0.05) / (b + 0.05);
}

const currentAccent = () => settings.accent || DEFAULT_ACCENT[effectiveDark() ? 'dark' : 'light'];

/** Push the settings into the document. The CSS reads them from there. */
function applySettings() {
  const root = document.documentElement;
  root.dataset.theme = settings.theme;
  // Overriding the media query needs an explicit colour-scheme, or a forced
  // light theme keeps the browser's dark form controls.
  root.style.colorScheme = settings.theme === 'auto' ? 'light dark' : settings.theme;

  const [r, g, b] = currentAccent();
  root.style.setProperty('--accent-r', r);
  root.style.setProperty('--accent-g', g);
  root.style.setProperty('--accent-b', b);

  document.body.dataset.compact = String(settings.compact);
  startAutoRefresh();
}

/* --- forced light/dark --- */

// The stylesheet expresses dark mode as a media query, which an in-page toggle
// cannot override. This mirrors those values under an attribute so a forced
// choice wins, without duplicating the whole palette.
const DARK_VARS = {
  '--bg': '#0d1017', '--surface': '#151a24', '--sunken': '#1c222e',
  '--border': '#2a323f', '--border-strong': '#3b4553',
  '--text': '#e7ebf2', '--text-2': '#b3bccb', '--text-3': '#8b96a8',
  '--accent-soft': '#2a1a24', '--danger': '#ff8a80', '--warn': '#e0b252', '--ok': '#6ee7a0',
  '--shadow': '0 1px 2px rgb(0 0 0 / 0.4), 0 4px 14px rgb(0 0 0 / 0.35)',
};
const LIGHT_VARS = {
  '--bg': '#f4f6fa', '--surface': '#ffffff', '--sunken': '#eef1f7',
  '--border': '#d7dde8', '--border-strong': '#b9c2d4',
  '--text': '#16202f', '--text-2': '#4a5568', '--text-3': '#6b7688',
  '--accent-soft': '#f7e9f0', '--danger': '#b3261e', '--warn': '#8a5300', '--ok': '#1a6b3c',
  '--shadow': '0 1px 2px rgb(16 24 40 / 0.06), 0 4px 12px rgb(16 24 40 / 0.05)',
};

function applyScheme() {
  const root = document.documentElement;
  const vars = settings.theme === 'auto' ? null : (settings.theme === 'dark' ? DARK_VARS : LIGHT_VARS);
  for (const key of Object.keys({ ...DARK_VARS })) root.style.removeProperty(key);
  if (!vars) return;
  for (const [key, value] of Object.entries(vars)) root.style.setProperty(key, value);
}

/* --- auto refresh --- */

let refreshTimer = null;

function startAutoRefresh() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = null;
  if (!settings.refresh) return;
  refreshTimer = setInterval(() => {
    // Not while a dialog is open: pulling the list out from under somebody
    // mid-decision is worse than a stale count.
    if (document.querySelector('dialog[open]')) return;
    Promise.all([refresh(), loadCounts()]).catch(() => {});
  }, settings.refresh * 1000);
}

/* --- the panel --- */

function fillSettingsForm() {
  const [r, g, b] = currentAccent();
  document.querySelector(`#settings-form input[name="ds-theme"][value="${settings.theme}"]`).checked = true;
  $('#ds-r').value = r;
  $('#ds-g').value = g;
  $('#ds-b').value = b;
  $('#ds-refresh').value = String(settings.refresh);
  $('#ds-tab').value = settings.tab;
  $('#ds-absolute').checked = settings.absoluteTimes;
  $('#ds-compact').checked = settings.compact;
  $('#ds-blur').checked = settings.blurReported;
  paintSwatch();
}

const hex = ([r, g, b]) => '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');

function paintSwatch() {
  const rgb = [Number($('#ds-r').value), Number($('#ds-g').value), Number($('#ds-b').value)];
  $('#ds-r-out').textContent = rgb[0];
  $('#ds-g-out').textContent = rgb[1];
  $('#ds-b-out').textContent = rgb[2];
  $('#ds-hex').textContent = `${hex(rgb)}  ·  rgb(${rgb.join(' ')})`;
  $('#ds-swatch').style.background = `rgb(${rgb.join(' ')})`;

  const ratio = contrastAgainstSurface(rgb);
  const note = $('#ds-contrast');
  if (ratio >= 4.5) {
    note.textContent = `Contrast ${ratio.toFixed(1)}:1 — passes AA for text.`;
  } else if (ratio >= 3) {
    note.textContent = `Contrast ${ratio.toFixed(1)}:1 — fine for borders and fills, too low for small text.`;
  } else {
    note.textContent = `Contrast ${ratio.toFixed(1)}:1 — labels in this colour will be hard to read.`;
  }
}

function wireSettings() {
  $('#btn-settings').addEventListener('click', () => {
    fillSettingsForm();
    $('#settings-dialog').showModal();
  });

  for (const radio of $$('#settings-form input[name="ds-theme"]')) {
    radio.addEventListener('change', () => {
      settings.theme = radio.value;
      // A forced scheme changes which default accent applies, so re-read it.
      applyScheme();
      applySettings();
      fillSettingsForm();
      saveSettings();
    });
  }

  for (const id of ['#ds-r', '#ds-g', '#ds-b']) {
    $(id).addEventListener('input', () => {
      settings.accent = [Number($('#ds-r').value), Number($('#ds-g').value), Number($('#ds-b').value)];
      paintSwatch();
      applySettings();
      saveSettings();
    });
  }

  $('#ds-reset-colour').addEventListener('click', () => {
    settings.accent = null;
    applySettings();
    fillSettingsForm();
    saveSettings();
  });

  $('#ds-refresh').addEventListener('change', () => {
    settings.refresh = Number($('#ds-refresh').value);
    applySettings();
    saveSettings();
  });

  $('#ds-tab').addEventListener('change', () => {
    settings.tab = $('#ds-tab').value;
    saveSettings();
  });

  for (const [id, key] of [['#ds-absolute', 'absoluteTimes'], ['#ds-compact', 'compact'], ['#ds-blur', 'blurReported']]) {
    $(id).addEventListener('change', () => {
      settings[key] = $(id).checked;
      applySettings();
      saveSettings();
      // These change how rows are built, so the visible list has to be rebuilt.
      if (key !== 'compact') refresh().catch(() => {});
    });
  }

  $('#ds-restore').addEventListener('click', () => {
    settings = { ...DEFAULTS };
    applyScheme();
    applySettings();
    fillSettingsForm();
    saveSettings();
    refresh().catch(() => {});
    toast('Defaults restored.', 'ok');
  });

  // Following the system means following it as it changes.
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (settings.theme === 'auto') { applySettings(); }
  });
}

/* ---------- go ---------- */

// Last line on purpose. start() reads `settings`, a `let` declared above in this
// file — invoking it before that line executes hits the temporal dead zone and
// the whole dashboard fails to render.
start();

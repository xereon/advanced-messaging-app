// ui.js — the chat screen controller: sidebar, messages, composer, menus,
// dialogs, settings UI, keyboard shortcuts, sounds and notifications.

import {
  $, $$, uid, debounce, esc, renderRich, initials, fmtTime, fmtDay, fmtCompact, downloadFile,
} from './util.js';
import * as db from './store.js';
import { getSettings, setSetting, resetSettings, THEMES, applySettings, loadSettings } from './settings.js';
import { AVATAR_COLORS } from './palette.js';

const REACT_SET = ['👍', '❤️', '😂', '🎉', '😮', '😢', '✅'];
const EMOJI_SET = [
  '😀', '😄', '😅', '😂', '🙂', '😉', '😊', '😍',
  '🤔', '😐', '😴', '🥳', '😎', '🤝', '👍', '👎',
  '👏', '🙏', '💪', '🎉', '✅', '❌', '⚠️', '❤️',
  '🔥', '💯', '☕', '🍕', '🌟', '📅', '📈', '🚀',
];

let me = null;
let signOutCb = null;
let activeConvoId = null;
let filter = 'all';
let replyTo = null;          // message object being replied to
let editing = null;          // message object being edited
let lastReadBeforeOpen = 0;  // for the "New messages" divider
let convoSearch = null;      // { q, hits: [msgId], idx }
let typingByConvo = new Map(); // convoId -> { names:Set, timer }
let pendingScrollMsg = null;
/** How many messages may be in the DOM at once. */
const RENDER_WINDOW = 120;
const RENDER_WINDOW_STEP = 120;
let renderWindow = RENDER_WINDOW;
let audioCtx = null;

/* ================= helpers ================= */

function announce(text) {
  if (!getSettings().announceMessages) return;
  const el = $('#sr-announcer');
  el.textContent = '';
  requestAnimationFrame(() => { el.textContent = text; });
}

function toast(text, kind = 'info') {
  const wrap = $('#toasts');
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.innerHTML = `<svg class="icon" aria-hidden="true"><use href="#i-${kind === 'error' ? 'alert' : kind === 'success' ? 'check' : 'info'}"/></svg><span></span>`;
  el.lastElementChild.textContent = text;
  wrap.append(el);
  setTimeout(() => el.remove(), 4200);
}

function confirmDialog(title, text, okLabel = 'Confirm') {
  return new Promise((resolve) => {
    const dlg = $('#confirm-dialog');
    $('#confirm-title').textContent = title;
    $('#confirm-text').textContent = text;
    $('#confirm-ok').textContent = okLabel;
    const done = (val) => { dlg.close(); cleanup(); resolve(val); };
    const onOk = () => done(true);
    const onCancel = () => done(false);
    const onClose = () => { cleanup(); resolve(false); };
    function cleanup() {
      $('#confirm-ok').removeEventListener('click', onOk);
      $('#confirm-cancel').removeEventListener('click', onCancel);
      dlg.removeEventListener('close', onClose);
    }
    $('#confirm-ok').addEventListener('click', onOk);
    $('#confirm-cancel').addEventListener('click', onCancel);
    dlg.addEventListener('close', onClose);
    dlg.showModal();
  });
}

function avatarEl(user, cls = 'avatar') {
  const span = document.createElement('span');
  span.className = cls;
  span.setAttribute('aria-hidden', 'true');
  span.style.setProperty('--av-bg', user?.avatarColor || '#334155');
  span.textContent = initials(user?.name || '?');
  return span;
}

function playBlip() {
  if (!getSettings().sounds) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const t = audioCtx.currentTime;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(660, t);
    osc.frequency.setValueAtTime(880, t + 0.08);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.06, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(t); osc.stop(t + 0.25);
  } catch { /* audio unavailable */ }
}

function notify(title, body) {
  if (!getSettings().desktopNotifs || document.hasFocus()) return;
  if (Notification.permission !== 'granted') return;
  try { new Notification(title, { body, silent: true }); } catch { /* blocked */ }
}

/* ================= conversation derivations ================= */

function convoView(convo) {
  if (convo.type === 'group') {
    return {
      title: convo.title || 'Group',
      color: '#4D7C0F',
      isGroup: true,
      subtitle: `${convo.members.length} members`,
    };
  }
  const otherId = convo.members.find((m) => m !== me.id) || me.id;
  const other = db.getUser(otherId);
  return {
    title: other?.name || 'Former guest',
    color: other?.avatarColor,
    other,
    subtitle: other ? personSubtitle(other) : 'This guest session has ended',
  };
}

function visibleMessages(convo) {
  const meta = db.convoMeta(me.id, convo.id);
  return db.messagesOf(convo.id).filter((m) => m.at > (meta.clearedBefore || 0));
}

function lastActivity(convo) {
  const msgs = visibleMessages(convo);
  return msgs.length ? msgs[msgs.length - 1].at : convo.createdAt;
}

/** Delivery status of one of my messages: sent → delivered → read. */
function statusOf(msg, convo) {
  const others = convo.members.filter((m) => m !== msg.from);
  const reads = db.readsOf(convo.id);
  // The server withholds reads from anyone who turned receipts off, so a
  // missing entry here simply never resolves to 'read'.
  if (msg.pending) return 'sending';
  if (msg.failed) return 'failed';
  if (others.length && others.every((u) => (reads[u] || 0) >= msg.at)) return 'read';
  if (msg.deliveredAt) return 'delivered';
  return 'sent';
}

const STATUS_META = {
  sending: { icon: 'i-clock', label: 'Sending' },
  failed: { icon: 'i-alert', label: 'Not sent — tap to retry' },
  sent: { icon: 'i-check', label: 'Sent' },
  delivered: { icon: 'i-check-double', label: 'Delivered' },
  read: { icon: 'i-check-double', label: 'Read' },
};

/* ================= unread badge ================= */

const BASE_TITLE = 'Relay';

/** Put the unread count where you can see it without the app in front. */
function refreshUnreadBadge() {
  const n = db.totalUnread();
  document.title = n ? `(${n}) ${BASE_TITLE}` : BASE_TITLE;
  if (navigator.setAppBadge) {
    if (n) navigator.setAppBadge(n).catch(() => {});
    else navigator.clearAppBadge?.().catch(() => {});
  }
}

/* ================= group management ================= */

let groupDialogConvoId = null;

async function openGroupDialog(convoId) {
  const convo = db.getConvo(convoId);
  if (!convo || convo.type !== 'group') return;
  groupDialogConvoId = convoId;
  hideErr('#group-error');
  $('#group-rename').value = convo.title || '';
  $('#group-add-search').value = '';
  $('#group-add-results').innerHTML = '';
  renderGroupMembers();
  $('#group-dialog').showModal();
}

function renderGroupMembers() {
  const convo = db.getConvo(groupDialogConvoId);
  const list = $('#group-members');
  list.innerHTML = '';
  if (!convo) return;
  const iCreated = convo.createdBy === me.id;

  for (const id of convo.members) {
    const person = db.getUser(id);
    if (!person) continue;
    const li = document.createElement('li');
    li.className = 'member-row';
    const av = avatarEl(person);
    const name = document.createElement('span');
    name.className = 'member-name';
    name.textContent = person.id === me.id ? `${person.name} (you)` : person.name;
    li.append(av, name);

    // You can always remove yourself; only the creator can remove anyone else.
    if (person.id !== me.id && iCreated) {
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'btn sm';
      remove.textContent = 'Remove';
      remove.setAttribute('aria-label', `Remove ${person.name} from the group`);
      remove.addEventListener('click', async () => {
        try {
          await db.removeMember(groupDialogConvoId, person.id);
          renderGroupMembers();
          renderSidebar();
          toast(`${person.name} removed`, 'success');
        } catch (err) { showErr('#group-error', err.message); }
      });
      li.append(remove);
    }
    list.append(li);
  }
}

function wireGroupDialog() {
  $('#btn-rename-group').addEventListener('click', async () => {
    try {
      await db.renameGroup(groupDialogConvoId, $('#group-rename').value);
      renderSidebar();
      if (activeConvoId === groupDialogConvoId) renderConvoHeader();
      toast('Group renamed', 'success');
    } catch (err) { showErr('#group-error', err.message); }
  });

  $('#group-add-search').addEventListener('input', debounce(async (e) => {
    const q = e.target.value.trim();
    const box = $('#group-add-results');
    box.innerHTML = '';
    if (!q) return;
    // Same floor as the New chat directory: nothing is asked of the server
    // until the query is specific enough to be about one person.
    if (searchTerm(q).length < DIRECTORY_MIN_QUERY) {
      box.innerHTML = `<p class="dir-note">Type at least ${DIRECTORY_MIN_QUERY} characters — name or @username.</p>`;
      return;
    }
    const convo = db.getConvo(groupDialogConvoId);
    const people = (await fetchPeople(q) || searchPeople(q))
      .filter((u) => !convo.members.includes(u.id) && !u.retired)
      .slice(0, 6);
    if (!people.length) { box.innerHTML = '<p class="convo-empty">Nobody new matches.</p>'; return; }
    for (const person of people) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'directory-item';
      row.append(avatarEl(person));
      const body = document.createElement('div');
      body.innerHTML = '<div class="dir-name"></div><div class="dir-role"></div>';
      body.querySelector('.dir-name').textContent = person.name;
      body.querySelector('.dir-role').textContent = personSubtitle(person);
      row.append(body);
      row.addEventListener('click', async () => {
        try {
          await db.addMember(groupDialogConvoId, person.id);
          $('#group-add-search').value = '';
          box.innerHTML = '';
          renderGroupMembers();
          renderSidebar();
          toast(`${person.name} added`, 'success');
        } catch (err) { showErr('#group-error', err.message); }
      });
      box.append(row);
    }
  }, 250));

  $('#btn-leave-group').addEventListener('click', async () => {
    const convo = db.getConvo(groupDialogConvoId);
    if (!await confirmDialog('Leave this group?',
      `You will stop receiving messages in “${convo?.title || 'this group'}”.`, 'Leave')) return;
    try {
      await db.removeMember(groupDialogConvoId, me.id);
      $('#group-dialog').close();
      if (activeConvoId === groupDialogConvoId) closeConvoToList();
      renderSidebar();
      toast('You left the group', 'success');
    } catch (err) { showErr('#group-error', err.message); }
  });
}

/* ================= profiles ================= */

/** Someone's local time, when they have published a zone. */
function localTimeIn(timezone, use24h) {
  if (!timezone) return null;
  try {
    return new Intl.DateTimeFormat([], {
      timeZone: timezone, hour: 'numeric', minute: '2-digit', hour12: !use24h,
    }).format(new Date());
  } catch {
    return null;   // a zone this browser does not recognise
  }
}

function statusLabel(user) {
  if (!user?.statusText && !user?.statusEmoji) return '';
  return `${user.statusEmoji || ''} ${user.statusText || ''}`.trim();
}

let profileUserId = null;

/** Open the profile card for anyone, including yourself. */
export async function openProfile(userId) {
  if (!userId) return;
  profileUserId = userId;
  const dlg = $('#profile-dialog');

  // Paint from cache first so the card is never empty while the request runs.
  const cached = db.getUser(userId);
  if (cached) paintProfile({ user: cached, isSelf: userId === me.id, isContact: db.isContact(me.id, userId),
    online: db.isOnline(cached), sharedConversations: [], directConversationId: null }, { partial: true });
  if (!dlg.open) dlg.showModal();

  try {
    const profile = await db.fetchProfile(userId);
    if (profileUserId !== userId) return;          // a different profile was opened
    paintProfile(profile, { partial: false });
  } catch (err) {
    toast(err.message, 'error');
    dlg.close();
  }
}

function paintProfile(profile, { partial }) {
  const { user, isSelf, isContact, online, sharedConversations, directConversationId } = profile;
  const s = getSettings();

  const av = $('#profile-avatar');
  av.style.setProperty('--av-bg', user.avatarColor || '#334155');
  av.textContent = initials(user.name);

  $('#profile-name').textContent = user.name;
  $('#profile-dialog-heading').textContent = isSelf ? 'Your profile' : 'Profile';

  const handle = $('#profile-username');
  handle.hidden = !user.username;
  handle.textContent = user.username ? `@${user.username}` : '';

  const meta = [user.pronouns, user.title || (user.isBot ? user.role : null)].filter(Boolean);
  if (user.isGuest) meta.push('Guest');
  if (user.retired) meta.push('Former guest');
  $('#profile-meta').textContent = meta.join(' · ');

  const status = statusLabel(user);
  const statusEl = $('#profile-status');
  statusEl.hidden = !status;
  statusEl.textContent = status;

  const bio = $('#profile-bio');
  bio.hidden = !user.bio;
  bio.textContent = user.bio || '';

  // Facts list — only rows we actually have something for.
  const facts = [];
  facts.push(['Availability', user.isBot ? 'Always online' : (online ? 'Online now' : lastSeenLabel(user))]);
  const theirTime = localTimeIn(user.timezone, s.use24h);
  if (theirTime) facts.push(['Local time', `${theirTime} · ${user.timezone.replace(/_/g, ' ')}`]);
  if (user.email) facts.push(['Email', user.email]);
  if (user.createdAt) facts.push(['Joined', fmtDay(user.createdAt)]);

  const dl = $('#profile-facts');
  dl.innerHTML = '';
  for (const [term, value] of facts) {
    const dt = document.createElement('dt');
    dt.textContent = term;
    const dd = document.createElement('dd');
    dd.textContent = value;
    dl.append(dt, dd);
  }

  // Shared conversations, once the server has answered.
  const sharedWrap = $('#profile-shared');
  sharedWrap.innerHTML = '';
  const groups = (sharedConversations || []).filter((c) => c.type === 'group');
  if (!partial && groups.length) {
    const h = document.createElement('h4');
    h.className = 'profile-subhead';
    h.textContent = groups.length === 1 ? 'One group in common' : `${groups.length} groups in common`;
    sharedWrap.append(h);
    const ul = document.createElement('ul');
    ul.className = 'profile-shared-list';
    for (const g of groups) {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'link-btn';
      btn.textContent = g.title || 'Group';
      btn.addEventListener('click', () => { $('#profile-dialog').close(); openConvo(g.id); });
      li.append(btn);
      ul.append(li);
    }
    sharedWrap.append(ul);
  }

  // Actions
  const contactBtn = $('#profile-contact-btn');
  const messageBtn = $('#profile-message-btn');
  contactBtn.hidden = isSelf || user.retired;
  messageBtn.hidden = isSelf || user.retired;
  if (!isSelf) {
    contactBtn.textContent = isContact ? 'Remove from contacts' : 'Add to contacts';
    contactBtn.onclick = () => {
      if (db.isContact(me.id, user.id)) db.removeContact(me.id, user.id);
      else db.addContact(me.id, user.id);
      contactBtn.textContent = db.isContact(me.id, user.id) ? 'Remove from contacts' : 'Add to contacts';
    };
    messageBtn.onclick = async () => {
      $('#profile-dialog').close();
      try {
        const convo = directConversationId
          ? db.getConvo(directConversationId) || await db.ensureDm(me.id, user.id)
          : await db.ensureDm(me.id, user.id);
        renderSidebar();
        openConvo(convo.id);
      } catch (err) { toast(err.message, 'error'); }
    };
  }
  if (isSelf) {
    contactBtn.hidden = false;
    contactBtn.textContent = 'Edit profile';
    contactBtn.onclick = () => { $('#profile-dialog').close(); openSettings('profile'); };
  }

  paintSafety(profile);
}

/**
 * The block/report row.
 *
 * Blocking is symmetric on the server, so the copy says what actually happens
 * rather than promising one-way invisibility. Bots and retired guests have
 * nobody to report, so they get no row at all.
 */
function paintSafety(profile) {
  const { user, isSelf } = profile;
  const wrap = $('#profile-safety');
  const show = !isSelf && !user.isBot && !user.retired;
  wrap.hidden = !show;
  if (!show) return;

  const blocked = profile.isBlocked ?? db.isBlocked(user.id);
  const note = $('#profile-block-note');
  note.hidden = !blocked;
  note.textContent = blocked
    ? `You blocked ${user.name}. Neither of you can message the other, and your conversation is hidden while the block stands.`
    : '';

  const blockBtn = $('#profile-block-btn');
  blockBtn.textContent = blocked ? 'Unblock' : 'Block';
  blockBtn.onclick = async () => {
    if (!blocked) {
      const ok = await confirmDialog(
        `Block ${user.name}?`,
        'You will stop seeing each other in search and neither of you can start a conversation. Your existing messages are hidden, not deleted — unblocking brings them back.',
        'Block',
      );
      if (!ok) return;
    }
    blockBtn.disabled = true;
    try {
      if (blocked) {
        await db.unblockUser(user.id);
        toast(`${user.name} is unblocked.`, 'success');
      } else {
        await db.blockUser(user.id);
        toast(`${user.name} is blocked.`, 'success');
        $('#profile-dialog').close();
        renderSidebar();
        return;
      }
      const fresh = await db.fetchProfile(user.id);
      paintProfile(fresh, { partial: false });
      renderSidebar();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      blockBtn.disabled = false;
    }
  };

  $('#profile-report-btn').onclick = () => {
    $('#profile-dialog').close();
    openReport({ subjectId: user.id, subjectName: user.name });
  };
}

/* ================= feedback ================= */

const FEEDBACK_MAX = 2000;

function openFeedback() {
  $('#feedback-message').value = '';
  $('#feedback-remaining').textContent = String(FEEDBACK_MAX);
  const first = $('#feedback-form input[name="feedback-kind"]');
  if (first) first.checked = true;
  hideErr('#feedback-error');
  $('#feedback-dialog').showModal();
  $('#feedback-message').focus();
}

function wireFeedback() {
  const box = $('#feedback-message');
  box.addEventListener('input', () => {
    $('#feedback-remaining').textContent = String(Math.max(FEEDBACK_MAX - box.value.length, 0));
  });

  $('#feedback-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const message = box.value.trim();
    if (!message) return showErr('#feedback-error', 'Say a little about it first.');

    const btn = e.target.querySelector('button[type="submit"]');
    btn.disabled = true;
    try {
      await db.submitFeedback({
        kind: $('#feedback-form input[name="feedback-kind"]:checked')?.value,
        message,
      });
      $('#feedback-dialog').close();
      toast('Thank you — your feedback was sent.', 'success');
    } catch (err) {
      showErr('#feedback-error', err.message);
    } finally {
      btn.disabled = false;
    }
  });
}

/* ================= reporting ================= */

let reportTarget = null;

/** Report a person, or one specific message of theirs. */
function openReport({ subjectId, subjectName, convoId = null, messageId = null, messageText = '' }) {
  reportTarget = { subjectId, convoId, messageId };
  $('#report-dialog-title').textContent = messageId ? 'Report this message' : `Report ${subjectName || 'this person'}`;
  const quote = $('#report-quote');
  quote.hidden = !messageText;
  quote.textContent = messageText || '';
  $('#report-note').value = '';
  $('#report-also-block').checked = false;
  const first = $('#report-form input[name="report-reason"]');
  if (first) first.checked = true;
  hideErr('#report-error');
  $('#report-dialog').showModal();
}

function lastSeenLabel(user) {
  if (!user.lastSeen) return 'Offline';
  const mins = Math.round((Date.now() - user.lastSeen) / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `Last seen ${mins} minute${mins === 1 ? '' : 's'} ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `Last seen ${hours} hour${hours === 1 ? '' : 's'} ago`;
  return `Last seen ${fmtDay(user.lastSeen)}`;
}

/* ================= people search ================= */

/** Everyone you could start a conversation with: colleagues, bots and any
    guest currently signed in — but not yourself and not retired guests. */
function directoryPeople() {
  return Object.values(db.allUsers()).filter((u) => u.id !== me.id && !u.retired);
}

function personSubtitle(person) {
  if (person.retired) return 'Former guest';
  const presence = db.isOnline(person) ? 'Online' : 'Offline';
  const status = statusLabel(person);
  const role = person.title || person.role;
  const parts = person.isBot
    ? [role, presence]
    : person.isGuest ? ['Guest', presence] : [role, presence];
  // A status the person set themselves is more useful than their job title.
  if (status) parts.unshift(status);
  // The handle leads: it is what you searched by and what tells two people
  // with the same display name apart.
  if (person.username) parts.unshift(`@${person.username}`);
  return parts.filter(Boolean).join(' · ');
}

/** The add/remove-contact toggle that sits beside a person anywhere they
    appear. Keeps itself in sync; sidebar/dialog refreshes ride the
    'contacts' store event. */
function contactToggleBtn(person) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn icon-btn sm contact-toggle';
  const sync = () => {
    const has = db.isContact(me.id, person.id);
    btn.setAttribute('aria-pressed', String(has));
    btn.title = has ? `Remove ${person.name} from contacts` : `Add ${person.name} to contacts`;
    btn.setAttribute('aria-label', btn.title);
    btn.innerHTML = `<svg class="icon sm" aria-hidden="true"><use href="#i-${has ? 'user-check' : 'user-plus'}"/></svg>`;
  };
  sync();
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const had = db.isContact(me.id, person.id);
    if (had) db.removeContact(me.id, person.id);
    else db.addContact(me.id, person.id);
    sync();
    toast(had ? `${person.name} removed from contacts` : `${person.name} added to contacts`, 'success');
  });
  return btn;
}

/**
 * How much has to be typed before the server is asked anything.
 *
 * The dialog used to request the whole directory the moment it opened. Now
 * nothing about who you are looking for leaves the browser until you have
 * typed enough to be looking for somebody specific. The server enforces the
 * same floor — this only saves the round trip.
 */
const DIRECTORY_MIN_QUERY = 3;

const searchTerm = (q) => String(q ?? '').trim().replace(/^@+/, '').toLowerCase();

/** Match on username, name, email and role, against people already cached. */
function personMatches(user, needle) {
  if (!needle) return true;
  return [user.username, user.name, user.email, user.role, user.isGuest ? 'guest' : '']
    .filter(Boolean)
    .some((field) => String(field).toLowerCase().includes(needle));
}

function peopleOrder(a, b) {
  const ca = db.isContact(me.id, a.id) ? 0 : 1;
  const cb = db.isContact(me.id, b.id) ? 0 : 1;
  if (ca !== cb) return ca - cb;
  const oa = db.isOnline(a) ? 0 : 1;
  const ob = db.isOnline(b) ? 0 : 1;
  return oa !== ob ? oa - ob : a.name.localeCompare(b.name);
}

/** Matches from what this client already knows about. */
function searchPeople(q) {
  return directoryPeople().filter((u) => personMatches(u, searchTerm(q))).sort(peopleOrder);
}

/**
 * Who to offer before a search has been typed.
 *
 * Your contacts and the people you already have conversations with. Every one
 * of them is already in this browser's cache, so showing them discloses
 * nothing new — unlike the old behaviour, which listed the entire server.
 */
function familiarPeople() {
  // Not simply "everyone cached": a search caches the strangers it returned, so
  // the cache stops being a list of people you know after the first one.
  const known = new Set();
  for (const convo of db.convosFor()) for (const id of convo.members) known.add(id);
  return directoryPeople()
    .filter((u) => known.has(u.id) || db.isContact(me.id, u.id) || u.isBot)
    .sort(peopleOrder);
}

/**
 * Ask the server who exists.
 *
 * The local cache only holds people you already share a conversation with,
 * plus contacts and the demo accounts. Anyone who registered separately is
 * simply not in it, so searching the cache alone can never find them — the
 * directory has to be a server query.
 */
let peopleQuerySeq = 0;
async function fetchPeople(q) {
  const token = ++peopleQuerySeq;
  try {
    const { users } = await db.searchDirectory(q);
    // A later keystroke already superseded this response.
    if (token !== peopleQuerySeq) return null;
    for (const u of users) db.cacheUser(u);
    return users;
  } catch {
    return null;   // offline or refused; cached results still show
  }
}

/** Server results unioned with cached ones, deduped and ordered together. */
function mergePeople(remote, q) {
  const byId = new Map();
  for (const u of searchPeople(q)) byId.set(u.id, u);
  for (const u of remote || []) {
    if (u.id !== me.id && !u.retired) byId.set(u.id, u);
  }
  return [...byId.values()].sort(peopleOrder);
}

/* ================= sidebar ================= */

function myConvos() {
  return db.convosFor().sort((a, b) => {
    const pa = db.convoMeta(me.id, a.id).pinned ? 1 : 0;
    const pb = db.convoMeta(me.id, b.id).pinned ? 1 : 0;
    if (pa !== pb) return pb - pa;
    return lastActivity(b) - lastActivity(a);
  });
}

function renderSidebar() {
  if (filter === 'contacts') { renderContactsList(); return; }
  const list = $('#convo-list');
  const s = getSettings();
  list.innerHTML = '';
  let convos = myConvos();
  if (filter === 'unread') convos = convos.filter((c) => db.unreadCount(c.id, me.id, db.convoMeta(me.id, c.id).clearedBefore) > 0);
  if (filter === 'pinned') convos = convos.filter((c) => db.convoMeta(me.id, c.id).pinned);

  if (!convos.length) {
    const empty = document.createElement('p');
    empty.className = 'convo-empty';
    empty.textContent = filter === 'all' ? 'No conversations yet. Start one!' : `No ${filter} conversations.`;
    list.append(empty);
    return;
  }

  for (const convo of convos) {
    const view = convoView(convo);
    const meta = db.convoMeta(me.id, convo.id);
    const msgs = visibleMessages(convo);
    const last = msgs[msgs.length - 1];
    const unread = db.unreadCount(convo.id, me.id, meta.clearedBefore);

    const btn = document.createElement('button');
    btn.className = 'convo-item';
    btn.setAttribute('role', 'listitem');
    btn.dataset.convoId = convo.id;
    if (convo.id === activeConvoId) btn.setAttribute('aria-current', 'true');

    const av = avatarEl({ name: view.title, avatarColor: view.color });
    if (view.other) {
      const dot = document.createElement('span');
      dot.className = 'presence-dot' + (db.isOnline(view.other) ? '' : ' off');
      av.append(dot);
    }

    const body = document.createElement('div');
    body.className = 'convo-item-body';

    let preview;
    if (meta.draft && convo.id !== activeConvoId) {
      preview = `<span class="draft">Draft:</span> ${esc(meta.draft)}`;
    } else if (last) {
      const who = last.from === me.id ? 'You: ' : (view.isGroup ? `${esc(db.getUser(last.from)?.name.split(' ')[0] || '?')}: ` : '');
      preview = last.deletedAt ? '<em>Message deleted</em>' : who + esc(last.text);
    } else {
      preview = '<em>No messages yet</em>';
    }

    body.innerHTML = `
      <div class="convo-item-top">
        <span class="convo-item-name"></span>
        ${meta.pinned ? '<svg class="icon sm pin-flag" aria-hidden="true"><use href="#i-pin"/></svg>' : ''}
        <span class="convo-item-time">${last ? fmtCompact(last.at, s.use24h) : ''}</span>
      </div>
      <div class="convo-item-bottom">
        <span class="convo-item-preview">${preview}</span>
        ${unread ? `<span class="unread-badge" aria-hidden="true">${unread > 99 ? '99+' : unread}</span>` : ''}
      </div>`;
    body.querySelector('.convo-item-name').textContent = view.title;

    const srBits = [view.title];
    if (unread) srBits.push(`${unread} unread`);
    if (meta.pinned) srBits.push('pinned');
    btn.setAttribute('aria-label', srBits.join(', '));

    btn.append(av, body);
    btn.addEventListener('click', () => openConvo(convo.id));
    list.append(btn);
  }
}

/* ---------- contacts tab ---------- */

function personRow(person, { onOpen }) {
  const row = document.createElement('div');
  row.className = 'person-row';
  const btn = document.createElement('button');
  btn.className = 'convo-item';
  btn.setAttribute('role', 'listitem');
  const av = avatarEl(person);
  const dot = document.createElement('span');
  dot.className = 'presence-dot' + (db.isOnline(person) ? '' : ' off');
  av.append(dot);
  btn.append(av);
  const body = document.createElement('div');
  body.className = 'convo-item-body';
  body.innerHTML = '<div class="convo-item-top"><span class="convo-item-name"></span></div><div class="search-hit-snippet"></div>';
  body.querySelector('.convo-item-name').textContent = person.name;
  body.querySelector('.search-hit-snippet').textContent = personSubtitle(person);
  btn.append(body);
  btn.setAttribute('aria-label', `${person.name}, ${personSubtitle(person)}. Open conversation.`);
  btn.addEventListener('click', () => onOpen(person));
  row.append(btn, contactToggleBtn(person));
  return row;
}

function renderContactsList() {
  const list = $('#convo-list');
  list.innerHTML = '';
  const people = db.contactUsers(me.id).sort((a, b) => {
    if (!!a.retired !== !!b.retired) return a.retired ? 1 : -1;
    const oa = db.isOnline(a) ? 0 : 1;
    const ob = db.isOnline(b) ? 0 : 1;
    return oa !== ob ? oa - ob : a.name.localeCompare(b.name);
  });
  if (!people.length) {
    const empty = document.createElement('p');
    empty.className = 'convo-empty';
    empty.textContent = 'No contacts yet. Search for someone above, or open “New conversation”, and press the add-to-contacts button next to their name.';
    list.append(empty);
    return;
  }
  for (const person of people) {
    list.append(personRow(person, {
      onOpen: async (p) => {
        const convo = await db.ensureDm(me.id, p.id);
        renderSidebar();
        openConvo(convo.id);
      },
    }));
  }
}

/* ---------- global search ---------- */

let remotePeople = { q: null, users: [] };
let remoteMessages = { q: null, results: [] };

function renderGlobalSearch(q) {
  const results = $('#search-results');
  const list = $('#convo-list');
  if (!q) {
    results.hidden = true;
    list.hidden = false;
    return;
  }
  list.hidden = true;
  results.hidden = false;
  results.innerHTML = '';
  const needle = q.toLowerCase();

  const convoHits = myConvos().filter((c) => convoView(c).title.toLowerCase().includes(needle));
  // Locally-known matches paint instantly; the server's full-history results
  // replace them a moment later. Searching only what is loaded would miss
  // anything older than the last 200 messages in a conversation.
  const localHits = [];
  for (const convo of myConvos()) {
    for (const m of visibleMessages(convo)) {
      if (!m.deletedAt && !m.system && m.text.toLowerCase().includes(needle)) {
        localHits.push({ convo, m });
        if (localHits.length >= 30) break;
      }
    }
    if (localHits.length >= 30) break;
  }

  const remoteMsgs = remoteMessages.q === q ? remoteMessages.results : null;
  const msgHits = remoteMsgs
    ? remoteMsgs.map((m) => ({ convo: db.getConvo(m.convoId), m })).filter((h) => h.convo)
    : localHits;

  if (q.length >= 2 && remoteMessages.q !== q) {
    db.searchMessages(q).then(({ results }) => {
      if ($('#global-search').value.trim() !== q) return;
      remoteMessages = { q, results };
      renderGlobalSearch(q);
    }).catch(() => { /* keep the local results */ });
  }

  const addHeading = (t) => {
    const h = document.createElement('h3');
    h.textContent = t;
    results.append(h);
  };

  if (convoHits.length) {
    addHeading('Conversations');
    for (const convo of convoHits) {
      const view = convoView(convo);
      const btn = document.createElement('button');
      btn.className = 'convo-item';
      btn.append(avatarEl({ name: view.title, avatarColor: view.color }));
      const b = document.createElement('div');
      b.className = 'convo-item-body';
      b.innerHTML = '<div class="convo-item-top"><span class="convo-item-name"></span></div>';
      b.querySelector('.convo-item-name').textContent = view.title;
      btn.append(b);
      btn.addEventListener('click', () => { clearGlobalSearch(); openConvo(convo.id); });
      // A DM you already have is still a person you may want in contacts.
      if (view.other) {
        const row = document.createElement('div');
        row.className = 'person-row';
        row.append(btn, contactToggleBtn(view.other));
        results.append(row);
      } else {
        results.append(btn);
      }
    }
  }
  // People you haven't opened a conversation with yet — searching a colleague
  // by name, email or role should be able to start the chat.
  const shownConvoIds = new Set(convoHits.map((c) => c.id));
  const remote = remotePeople.q === q ? remotePeople.users : null;
  const peopleHits = mergePeople(remote, q)
    .filter((u) => !shownConvoIds.has(db.dmId(me.id, u.id)))
    .slice(0, 8);

  // Fetch the server's view once per query, then repaint with it. Without this
  // the People section can only ever list accounts already in the cache.
  if (remotePeople.q !== q) {
    fetchPeople(q).then((users) => {
      if (!users) return;
      if ($('#global-search').value.trim() !== q) return;
      remotePeople = { q, users };
      renderGlobalSearch(q);
    });
  }
  if (peopleHits.length) {
    addHeading('People');
    for (const person of peopleHits) {
      results.append(personRow(person, {
        onOpen: async (p) => {
          clearGlobalSearch();
          const convo = await db.ensureDm(me.id, p.id);
          renderSidebar();
          openConvo(convo.id);
        },
      }));
    }
  }

  if (msgHits.length) {
    addHeading('Messages');
    for (const { convo, m } of msgHits) {
      const view = convoView(convo);
      const btn = document.createElement('button');
      btn.className = 'convo-item';
      btn.append(avatarEl({ name: view.title, avatarColor: view.color }));
      const b = document.createElement('div');
      b.className = 'convo-item-body';
      b.innerHTML = `
        <div class="convo-item-top"><span class="convo-item-name"></span>
          <span class="convo-item-time">${fmtCompact(m.at, getSettings().use24h)}</span></div>
        <div class="search-hit-snippet"></div>`;
      b.querySelector('.convo-item-name').textContent = view.title;
      b.querySelector('.search-hit-snippet').textContent = m.text;
      btn.append(b);
      btn.addEventListener('click', () => {
        clearGlobalSearch();
        pendingScrollMsg = m.id;
        openConvo(convo.id);
        renderWindow = Number.MAX_SAFE_INTEGER;
        renderMessages();
      });
      results.append(btn);
    }
  }
  if (!convoHits.length && !peopleHits.length && !msgHits.length) {
    const p = document.createElement('p');
    p.className = 'convo-empty';
    p.textContent = `No results for “${q}”.`;
    results.append(p);
  }
}

function clearGlobalSearch() {
  $('#global-search').value = '';
  renderGlobalSearch('');
}

/* ================= conversation pane ================= */

function openConvo(convoId) {
  const convo = db.getConvo(convoId);
  if (!convo) return;
  cancelComposeContext();
  closeConvoSearch();
  pendingAttachments = [];
  renderAttachmentTray();
  activeMsgId = null;
  renderWindow = RENDER_WINDOW;
  for (const open of $$('#messages .msg.actions-open')) open.classList.remove('actions-open');
  activeConvoId = convoId;
  lastReadBeforeOpen = db.readsOf(convoId)[me.id] || 0;
  $('#empty-state').hidden = true;
  $('#convo').hidden = false;
  $('#chat-screen').dataset.mobileView = 'convo';

  renderConvoHeader();
  renderMessages();
  db.markRead(convoId, me.id);
  renderSidebar();

  const input = $('#composer-input');
  input.value = db.convoMeta(me.id, convoId).draft || '';
  autosize(input);
  updateSendState();
  if (window.matchMedia('(min-width: 701px)').matches) input.focus();
}

function closeConvoToList() {
  $('#chat-screen').dataset.mobileView = 'list';
  activeConvoId = null;
  $('#convo').hidden = true;
  $('#empty-state').hidden = false;
  renderSidebar();
}

/**
 * Replace a single message node in place, rather than rebuilding the list.
 *
 * `previousId` is set when a pending message has just been confirmed: the node
 * on screen still carries the temporary id, so that is what has to be found.
 */
function patchMessageNode(msg, previousId) {
  const wrap = $('#messages');
  const existing = wrap.querySelector(`[data-msg-id="${CSS.escape(previousId || msg.id)}"]`);
  if (!existing) return false;
  // If both the pending node and a confirmed node somehow exist, drop the
  // stale one rather than leaving the message on screen twice.
  if (previousId) {
    const confirmed = wrap.querySelector(`[data-msg-id="${CSS.escape(msg.id)}"]`);
    if (confirmed && confirmed !== existing) existing.remove();
  }
  const convo = db.getConvo(activeConvoId);
  if (!convo) return false;
  const list = visibleMessages(convo);
  const i = list.findIndex((m) => m.id === msg.id);
  if (i === -1) return false;
  const prev = list[i - 1];
  const next = list[i + 1];
  const groupStart = !prev || prev.from !== msg.from || msg.at - prev.at > 300000
    || dayKey(prev.at) !== dayKey(msg.at);
  const groupEnd = !next || next.from !== msg.from || next.at - msg.at > 300000;
  const wasActive = existing.tabIndex === 0;
  const fresh = messageEl(convo, msg, { groupStart, groupEnd, highlight: convoSearch?.q?.toLowerCase() || '' });
  existing.replaceWith(fresh);
  if (wasActive) fresh.tabIndex = 0;
  return true;
}

/** Append one newly arrived message without touching the rest of the list. */
function appendMessageNode(msg) {
  const wrap = $('#messages');
  const convo = db.getConvo(activeConvoId);
  if (!convo || wrap.querySelector(`[data-msg-id="${CSS.escape(msg.id)}"]`)) return false;
  const list = visibleMessages(convo);
  // Belt and braces: a rendered node whose message is no longer in the cache is
  // an orphan left by a reconciliation, and would read as a duplicate.
  const live = new Set(list.map((m) => m.id));
  for (const node of wrap.querySelectorAll('.msg[data-msg-id]')) {
    if (!live.has(node.dataset.msgId)) node.remove();
  }
  if (list[list.length - 1]?.id !== msg.id) return false;   // out of order: full render
  if (!wrap.querySelector('.msg')) return false;            // empty state present

  const prev = list[list.length - 2];
  if (prev && dayKey(prev.at) !== dayKey(msg.at)) return false;  // needs a day divider
  const groupStart = !prev || prev.from !== msg.from || msg.at - prev.at > 300000;
  if (prev) {
    const prevEl = wrap.querySelector(`[data-msg-id="${CSS.escape(prev.id)}"]`);
    // The previous message may stop being the group end; re-render it.
    if (prevEl && !groupStart) patchMessageNode(prev);
  }
  wrap.append(messageEl(convo, msg, { groupStart, groupEnd: true, highlight: convoSearch?.q?.toLowerCase() || '' }));
  refreshRovingTabstop();
  return true;
}

async function loadOlderMessages(btn) {
  const wrap = $('#messages');
  const convoId = activeConvoId;
  btn.disabled = true;
  btn.textContent = 'Loading…';
  try {
    const added = await db.loadOlder(convoId);
    if (convoId !== activeConvoId) return;
    renderWindow += added;
    // renderMessages keeps the reading position steady as content grows above.
    renderMessages();
    announce(added ? `${added} earlier messages loaded.` : 'No earlier messages.');
  } catch (err) {
    btn.disabled = false;
    btn.textContent = 'Load earlier messages';
    toast(err.message, 'error');
  }
}

function renderConvoHeader() {
  const convo = db.getConvo(activeConvoId);
  if (!convo) return;
  const view = convoView(convo);
  const meta = db.convoMeta(me.id, convo.id);
  const av = $('#convo-avatar');
  av.style.setProperty('--av-bg', view.color || '#334155');
  av.textContent = initials(view.title);
  $('#convo-title').textContent = view.title;

  // Only a direct conversation has a person behind it to open.
  const openable = !!view.other;
  for (const el of [av, $('#convo-title')]) {
    el.classList.toggle('opens-profile', openable);
    if (openable) {
      el.setAttribute('role', 'button');
      el.setAttribute('tabindex', '0');
      el.setAttribute('aria-label', `${view.title} — open profile`);
    } else {
      el.removeAttribute('role');
      el.removeAttribute('tabindex');
      el.removeAttribute('aria-label');
    }
  }

  const sub = $('#convo-subtitle');
  sub.innerHTML = '';
  if (view.other) {
    const dot = document.createElement('span');
    dot.className = 'presence-dot' + (db.isOnline(view.other) ? '' : ' off');
    dot.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span');
    label.className = 'convo-subtitle-text';
    label.textContent = view.subtitle;
    sub.append(dot, label);
  } else {
    const names = convo.members.filter((m) => m !== me.id)
      .map((m) => db.getUser(m)?.name.split(' ')[0] || '?').join(', ');
    sub.textContent = `You, ${names}`;
  }

  const pinBtn = $('#btn-convo-pin');
  pinBtn.setAttribute('aria-pressed', String(!!meta.pinned));
  pinBtn.title = meta.pinned ? 'Unpin conversation' : 'Pin conversation';
  pinBtn.setAttribute('aria-label', pinBtn.title);
  $('#mute-label').textContent = meta.muted ? 'Unmute notifications' : 'Mute notifications';
  $('#convo-menu [data-action="group-details"]').hidden = convo.type !== 'group';

  // Contacts apply to a person, so the menu item only makes sense in a DM.
  const contactItem = $('#convo-menu [data-action="contact"]');
  contactItem.hidden = !view.other;
  if (view.other) {
    const has = db.isContact(me.id, view.other.id);
    $('#contact-label').textContent = has ? 'Remove from contacts' : 'Add to contacts';
    $('#contact-menu-icon').setAttribute('href', has ? '#i-user-check' : '#i-user-plus');
  }
}

function dayKey(ts) { return new Date(ts).toDateString(); }

function renderMessages() {
  const convo = db.getConvo(activeConvoId);
  if (!convo) return;
  const s = getSettings();
  const wrap = $('#messages');
  wrap.setAttribute('role', 'list');

  // Work out the window before anything is drawn: only a slice of the history
  // is ever in the DOM, so the node count stays bounded however far somebody
  // scrolls in one sitting. Paging back or searching raises the ceiling.
  const all = visibleMessages(convo);
  const msgs = all.length > renderWindow ? all.slice(-renderWindow) : all;
  const trimmed = all.length - msgs.length;
  const stickToBottom = wrap.scrollHeight - wrap.scrollTop - wrap.clientHeight < 160;
  // Clearing the list resets scrollTop, so remember where the reader was and
  // how much content sat above them. Growing the list above the viewport must
  // not yank them to the top.
  const prevScrollTop = wrap.scrollTop;
  const prevHeight = wrap.scrollHeight;
  wrap.innerHTML = '';

  // Older messages already loaded but outside the window.
  if (trimmed > 0) {
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'load-older';
    more.textContent = `Show ${Math.min(trimmed, RENDER_WINDOW_STEP)} earlier messages`;
    more.addEventListener('click', () => {
      renderWindow += RENDER_WINDOW_STEP;
      renderMessages();
    });
    wrap.append(more);
  }

  // "Load earlier" sits above the first message.
  if (trimmed === 0 && db.hasOlder(convo.id)) {
    const older = document.createElement('button');
    older.type = 'button';
    older.className = 'load-older';
    older.textContent = 'Load earlier messages';
    older.addEventListener('click', () => loadOlderMessages(older));
    wrap.append(older);
  }

  const q = convoSearch?.q?.toLowerCase() || '';
  let lastDay = '';
  let dividerPlaced = false;

  msgs.forEach((m, i) => {
    if (dayKey(m.at) !== lastDay) {
      lastDay = dayKey(m.at);
      const div = document.createElement('div');
      div.className = 'day-divider';
      div.textContent = fmtDay(m.at);
      wrap.append(div);
    }
    if (!dividerPlaced && lastReadBeforeOpen && m.at > lastReadBeforeOpen && m.from !== me.id) {
      dividerPlaced = true;
      const div = document.createElement('div');
      div.className = 'unread-divider';
      div.textContent = 'New messages';
      wrap.append(div);
    }
    const prev = msgs[i - 1];
    const next = msgs[i + 1];
    const groupStart = !prev || prev.from !== m.from || m.at - prev.at > 300000 || dayKey(prev.at) !== lastDay;
    const groupEnd = !next || next.from !== m.from || next.at - m.at > 300000;
    wrap.append(messageEl(convo, m, { groupStart, groupEnd, highlight: q }));
  });

  if (!msgs.length) {
    const p = document.createElement('p');
    p.className = 'convo-empty';
    p.textContent = 'No messages yet — say hello!';
    wrap.append(p);
  }

  if (pendingScrollMsg) {
    const target = wrap.querySelector(`[data-msg-id="${CSS.escape(pendingScrollMsg)}"]`);
    pendingScrollMsg = null;
    if (target) {
      target.scrollIntoView({ block: 'center' });
      target.classList.add('flash');
    }
  } else if (stickToBottom) {
    // The list has CSS smooth scrolling for the jump-to-latest button;
    // restoring position after a re-render must be immediate, or the queued
    // animation simply discards it.
    wrap.scrollTo({ top: wrap.scrollHeight, behavior: 'instant' });
  } else {
    wrap.scrollTo({ top: prevScrollTop + (wrap.scrollHeight - prevHeight), behavior: 'instant' });
  }
  refreshRovingTabstop();
  updateJumpButton();
}

function messageEl(convo, m, { groupStart, groupEnd, highlight }) {
  const s = getSettings();
  const mine = m.from === me.id;
  const author = db.getUser(m.from);
  const el = document.createElement('div');
  el.className = `msg ${mine ? 'out' : 'in'}${groupStart ? ' group-start' : ''}${groupEnd ? ' group-end' : ''}${m.deletedAt ? ' deleted' : ''}${m.pending ? ' pending' : ''}${m.queued ? ' queued' : ''}${m.failed ? ' failed' : ''}`;
  el.dataset.msgId = m.id;
  // Roving tabindex: only the active message is tabbable, so the whole list is
  // a single tab stop and arrow keys move between messages.
  el.tabIndex = -1;
  el.setAttribute('role', 'listitem');

  if (m.system) {
    el.className = 'msg system';
    el.dataset.msgId = m.id;
    el.tabIndex = -1;
    el.setAttribute('role', 'listitem');
    const note = document.createElement('p');
    note.className = 'system-note';
    note.textContent = m.text;
    el.append(note);
    return el;
  }

  if (!mine) {
    if (groupEnd) el.append(avatarEl(author, 'avatar'));
    else { const sp = document.createElement('span'); sp.className = 'avatar-spacer'; el.append(sp); }
  }

  const body = document.createElement('div');
  body.className = 'msg-body';

  if (groupStart && !mine && convo.type === 'group') {
    const meta = document.createElement('div');
    meta.className = 'msg-meta';
    meta.innerHTML = '<span class="msg-author"></span>';
    meta.querySelector('.msg-author').textContent = author?.name || 'Unknown';
    body.append(meta);
  }

  const bubble = document.createElement('div');
  bubble.className = 'bubble';

  if (m.replyTo && !m.deletedAt) {
    const orig = db.messagesOf(convo.id).find((x) => x.id === m.replyTo);
    const quote = document.createElement('div');
    quote.className = 'reply-quote';
    const qAuthor = orig ? (db.getUser(orig.from)?.name || 'Unknown') : '';
    quote.innerHTML = '<strong></strong><span></span>';
    quote.querySelector('strong').textContent = orig ? qAuthor : 'Original message unavailable';
    quote.querySelector('span').textContent = orig ? (orig.deletedAt ? 'Message deleted' : orig.text.slice(0, 120)) : '';
    bubble.append(quote);
  }

  const textEl = document.createElement('span');
  textEl.className = 'msg-text';
  if (m.deletedAt) {
    textEl.textContent = 'This message was deleted';
  } else {
    let html = renderRich(m.text);
    if (highlight) {
      const re = new RegExp(highlight.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
      html = html.replace(/(>[^<]*<)|^[^<]+|[^>]+$/g, (chunk) =>
        chunk.replace(re, (hit) => `<mark${convoSearch?.hits[convoSearch.idx] === m.id ? ' class="active-hit"' : ''}>${hit}</mark>`));
    }
    textEl.innerHTML = html;
  }
  if (!m.deletedAt && m.attachments?.length) {
    bubble.append(attachmentsEl(m));
  }
  bubble.append(textEl);

  const tail = document.createElement('span');
  tail.className = 'msg-tail';
  const time = fmtTime(m.at, s.use24h);
  let tailHtml = `${m.editedAt && !m.deletedAt ? '<span title="Edited">edited · </span>' : ''}<span class="msg-time">${time}</span>`;
  if (mine && !m.deletedAt) {
    const st = statusOf(m, convo);
    const sm = STATUS_META[st];
    tailHtml += ` <svg class="status-icon${st === 'read' ? ' read' : ''}" role="img" aria-label="${sm.label}"><title>${sm.label}</title><use href="#${sm.icon}"/></svg>`;
  }
  tail.innerHTML = tailHtml;
  bubble.append(tail);
  body.append(bubble);

  // Reactions
  const reactions = m.reactions && Object.entries(m.reactions).filter(([, users]) => users.length);
  if (reactions?.length && !m.deletedAt) {
    const row = document.createElement('div');
    row.className = 'reactions';
    for (const [emoji, users] of reactions) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'reaction-chip' + (users.includes(me.id) ? ' mine' : '');
      chip.tabIndex = -1;
      const names = users.map((u) => db.getUser(u)?.name || 'someone').join(', ');
      chip.setAttribute('aria-label', `${emoji} ${users.length}, reacted by ${names}. Toggle your reaction.`);
      chip.setAttribute('aria-pressed', String(users.includes(me.id)));
      chip.textContent = `${emoji} ${users.length}`;
      chip.title = names;
      chip.addEventListener('click', () => db.toggleReaction(convo.id, m.id, emoji));
      row.append(chip);
    }
    body.append(row);
  }
  el.append(body);

  // Hover / focus actions
  if (!m.deletedAt) {
    const actions = document.createElement('div');
    actions.className = 'msg-actions';
    actions.setAttribute('role', 'toolbar');
    actions.setAttribute('aria-label', 'Message actions');
    const mkBtn = (icon, label, fn) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn icon-btn sm';
      b.tabIndex = -1;
      b.setAttribute('aria-label', label);
      b.title = label;
      b.innerHTML = `<svg class="icon sm" aria-hidden="true"><use href="#i-${icon}"/></svg>`;
      b.addEventListener('click', fn);
      return b;
    };
    actions.append(
      mkBtn('smile', 'Add reaction', (e) => openReactPalette(e.currentTarget, convo.id, m.id)),
      mkBtn('reply', 'Reply', () => startReply(m)),
      mkBtn('copy', 'Copy text', async () => {
        try { await navigator.clipboard.writeText(m.text); toast('Copied to clipboard', 'success'); }
        catch { toast('Could not copy — clipboard is unavailable.', 'error'); }
      }),
    );
    if (mine) {
      actions.append(
        mkBtn('edit', 'Edit message', () => startEdit(m)),
        mkBtn('trash', 'Delete message', async () => {
          if (await confirmDialog('Delete message?', 'This removes the message for everyone in the conversation.', 'Delete')) {
            db.patchMessage(convo.id, m.id, { deletedAt: Date.now() });
          }
        }),
      );
    } else if (!db.getUser(m.from)?.isBot) {
      actions.append(
        mkBtn('alert', 'Report message', () => openReport({
          subjectId: m.from,
          subjectName: db.getUser(m.from)?.name,
          convoId: convo.id,
          messageId: m.id,
          messageText: m.text,
        })),
      );
    }
    el.append(actions);
  }
  return el;
}

/* ---------- message list keyboard navigation ---------- */

/** The message that currently owns the list's single tab stop. */
let activeMsgId = null;

function messageEls() { return $$('#messages .msg'); }

function setActiveMessage(el, { focus = true } = {}) {
  if (!el) return;
  for (const other of messageEls()) other.tabIndex = -1;
  el.tabIndex = 0;
  activeMsgId = el.dataset.msgId;
  if (focus) el.focus();
}

/** Keep exactly one message tabbable after any re-render. */
function refreshRovingTabstop() {
  const els = messageEls();
  if (!els.length) return;
  const current = els.find((el) => el.dataset.msgId === activeMsgId);
  const target = current || els[els.length - 1];
  for (const el of els) el.tabIndex = el === target ? 0 : -1;
  activeMsgId = target.dataset.msgId;
}

/** Touch devices have no hover, so message actions are revealed by tapping the
    message. Taps on links, buttons and reactions keep their own behaviour. */
function wireTouchMessageActions() {
  const list = $('#messages');
  let lastPointerWasTouch = false;

  // Per-interaction, not per-device: a hybrid laptop should get the tap
  // behaviour when touched and the hover behaviour when using a trackpad.
  list.addEventListener('pointerdown', (e) => { lastPointerWasTouch = e.pointerType === 'touch'; }, true);

  list.addEventListener('click', (e) => {
    if (!lastPointerWasTouch) return;
    if (e.target.closest('a, button, .reaction-chip')) return;
    const msg = e.target.closest('.msg');
    if (!msg || msg.classList.contains('deleted')) return;
    const wasOpen = msg.classList.contains('actions-open');
    for (const other of $$('#messages .msg.actions-open')) other.classList.remove('actions-open');
    if (!wasOpen) {
      msg.classList.add('actions-open');
      setActiveMessage(msg, { focus: false });
    }
  });

  // Tapping away closes the open toolbar.
  document.addEventListener('click', (e) => {
    if (e.target.closest('.msg')) return;
    for (const msg of $$('#messages .msg.actions-open')) msg.classList.remove('actions-open');
  });
}

/** The on-screen keyboard shrinks the visual viewport without changing
    window.innerHeight on iOS, which would leave the composer underneath it. */
function wireVisualViewport() {
  const vv = window.visualViewport;
  if (!vv) return;
  const root = document.documentElement;
  const apply = () => {
    // Only override the height when the on-screen keyboard is genuinely up.
    // The visual and layout viewports differ slightly for other reasons
    // (scrollbars, browser UI), and clamping to that would leave dead space.
    const keyboardInset = window.innerHeight - vv.height;
    if (keyboardInset > 120) root.style.setProperty('--app-height', `${Math.round(vv.height)}px`);
    else root.style.removeProperty('--app-height');
  };
  vv.addEventListener('resize', apply);
  window.addEventListener('orientationchange', () => setTimeout(apply, 200));
  apply();

  // Bring the newest message back into view once the keyboard has settled.
  $('#composer-input').addEventListener('focus', () => {
    setTimeout(() => {
      const wrap = $('#messages');
      if (wrap.scrollHeight - wrap.scrollTop - wrap.clientHeight < 240) {
        wrap.scrollTo({ top: wrap.scrollHeight, behavior: 'instant' });
      }
    }, 250);
  });
}

function wireMessageKeys() {
  const list = $('#messages');

  list.addEventListener('focusin', (e) => {
    const msg = e.target.closest('.msg');
    if (msg && e.target === msg) setActiveMessage(msg, { focus: false });
  });

  list.addEventListener('keydown', (e) => {
    const msg = e.target.closest('.msg');
    if (!msg) return;
    const els = messageEls();
    const i = els.indexOf(msg);

    // Arrow keys move between messages; Tab still leaves the list entirely.
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveMessage(els[e.key === 'ArrowDown' ? Math.min(i + 1, els.length - 1) : Math.max(i - 1, 0)]);
      return;
    }
    if (e.key === 'Home') { e.preventDefault(); setActiveMessage(els[0]); return; }
    if (e.key === 'End') { e.preventDefault(); setActiveMessage(els[els.length - 1]); return; }

    if (e.target !== msg) return;   // already inside the action toolbar

    // Enter or Right steps into this message's actions.
    if (e.key === 'Enter' || e.key === 'ArrowRight') {
      const first = msg.querySelector('.msg-actions button');
      if (first) { e.preventDefault(); first.focus(); }
      return;
    }
    const id = msg.dataset.msgId;
    const m = db.messagesOf(activeConvoId).find((x) => x.id === id);
    if (!m || m.deletedAt) return;
    if (e.key.toLowerCase() === 'r') { e.preventDefault(); startReply(m); }
    if (e.key.toLowerCase() === 'e' && m.from === me.id) { e.preventDefault(); startEdit(m); }
    if (e.key.toLowerCase() === 'c') {
      e.preventDefault();
      navigator.clipboard?.writeText(m.text).then(
        () => toast('Copied to clipboard', 'success'),
        () => toast('Could not copy — clipboard is unavailable.', 'error'),
      );
    }
  });

  // Escape from the toolbar returns focus to its message.
  list.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const inToolbar = e.target.closest('.msg-actions');
    if (!inToolbar) return;
    e.stopPropagation();
    setActiveMessage(inToolbar.closest('.msg'));
  });
}

const formatBytes = (n) => (
  n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`
);

function attachmentsEl(msg) {
  const wrap = document.createElement('div');
  wrap.className = 'attachments';
  for (const a of msg.attachments) {
    if (a.isImage) {
      const link = document.createElement('a');
      link.className = 'attachment-image';
      link.href = a.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.tabIndex = -1;
      const img = document.createElement('img');
      img.src = a.url;
      img.loading = 'lazy';
      img.decoding = 'async';
      // The filename is the only description we have; better than nothing for
      // a screen reader, and the size keeps the layout from jumping.
      img.alt = a.name;
      if (a.width && a.height) { img.width = a.width; img.height = a.height; }
      link.append(img);
      link.setAttribute('aria-label', `Image, ${a.name}. Opens full size.`);
      wrap.append(link);
    } else {
      const link = document.createElement('a');
      link.className = 'attachment-file';
      link.href = `${a.url}?download=1`;
      link.tabIndex = -1;
      link.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#i-paperclip"/></svg><span class="attachment-name"></span><span class="attachment-size"></span>';
      link.querySelector('.attachment-name').textContent = a.name;
      link.querySelector('.attachment-size').textContent = formatBytes(a.size);
      link.setAttribute('aria-label', `Download ${a.name}, ${formatBytes(a.size)}`);
      wrap.append(link);
    }
  }
  return wrap;
}

/** Update just the delivery-status icons on your own messages. */
function refreshOwnStatuses() {
  const convo = db.getConvo(activeConvoId);
  if (!convo) return;
  for (const m of visibleMessages(convo)) {
    if (m.from !== me.id || m.deletedAt) continue;
    const el = $(`#messages [data-msg-id="${CSS.escape(m.id)}"] .status-icon`);
    if (!el) continue;
    const meta = STATUS_META[statusOf(m, convo)];
    el.setAttribute('aria-label', meta.label);
    el.classList.toggle('read', statusOf(m, convo) === 'read');
    const title = el.querySelector('title');
    if (title) title.textContent = meta.label;
    el.querySelector('use')?.setAttribute('href', `#${meta.icon}`);
  }
}

/* ---------- react palette ---------- */

let paletteEl = null;
function closeReactPalette() { paletteEl?.remove(); paletteEl = null; }

function openReactPalette(anchor, convoId, msgId) {
  closeReactPalette();
  paletteEl = document.createElement('div');
  paletteEl.className = 'react-palette';
  paletteEl.setAttribute('role', 'menu');
  paletteEl.setAttribute('aria-label', 'Pick a reaction');
  for (const emoji of REACT_SET) {
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('role', 'menuitem');
    b.setAttribute('aria-label', `React with ${emoji}`);
    b.textContent = emoji;
    b.addEventListener('click', () => { db.toggleReaction(convoId, msgId, emoji); closeReactPalette(); });
    paletteEl.append(b);
  }
  document.body.append(paletteEl);
  const r = anchor.getBoundingClientRect();
  const pw = paletteEl.offsetWidth;
  paletteEl.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - pw - 8))}px`;
  paletteEl.style.top = `${Math.max(8, r.top - paletteEl.offsetHeight - 6)}px`;
  paletteEl.querySelector('button').focus();
}

/* ---------- typing indicator ---------- */

function showTyping(convoId, name) {
  const entry = typingByConvo.get(convoId) || { names: new Set(), timer: null };
  entry.names.add(name);
  clearTimeout(entry.timer);
  entry.timer = setTimeout(() => { typingByConvo.delete(convoId); renderTyping(); }, 4000);
  typingByConvo.set(convoId, entry);
  renderTyping();
}

function renderTyping() {
  const el = $('#typing-indicator');
  const entry = activeConvoId && typingByConvo.get(activeConvoId);
  if (!entry || !getSettings().typingIndicators) { el.hidden = true; el.textContent = ''; return; }
  const names = [...entry.names];
  el.textContent = names.length === 1 ? `${names[0]} is typing…` : `${names.join(' and ')} are typing…`;
  el.hidden = false;
}

/* ---------- jump to latest ---------- */

function updateJumpButton(newIncoming = false) {
  const wrap = $('#messages');
  const btn = $('#jump-latest');
  const away = wrap.scrollHeight - wrap.scrollTop - wrap.clientHeight > 300;
  if (away) {
    if (newIncoming) $('#jump-latest-label').textContent = 'New messages';
    btn.hidden = false;
  } else {
    btn.hidden = true;
    $('#jump-latest-label').textContent = 'Latest messages';
  }
}

/* ================= composer ================= */

function autosize(ta) {
  ta.style.height = 'auto';
  ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`;
}

function updateSendState() {
  const input = $('#composer-input');
  const len = input.value.length;
  $('#btn-send').disabled = !input.value.trim() && pendingAttachments.length === 0;
  const counter = $('#char-count');
  if (len > 3500) {
    counter.hidden = false;
    counter.textContent = `${len} / 4000`;
    counter.classList.toggle('limit', len >= 4000);
  } else counter.hidden = true;
}

const saveDraft = debounce(() => {
  if (!activeConvoId) return;
  db.setConvoMeta(me.id, activeConvoId, { draft: $('#composer-input').value });
}, 400);

const broadcastTyping = (() => {
  let last = 0;
  return () => {
    if (!getSettings().typingIndicators || !activeConvoId) return;
    const now = Date.now();
    if (now - last < 2500) return;
    last = now;
    db.sendTyping(activeConvoId);
  };
})();

function startReply(m) {
  cancelComposeContext();
  replyTo = m;
  const box = $('#composer-context');
  $('#composer-context-title').textContent = `Replying to ${db.getUser(m.from)?.name || 'message'}`;
  $('#composer-context-text').textContent = m.text;
  box.hidden = false;
  $('#composer-input').focus();
}

function startEdit(m) {
  cancelComposeContext();
  editing = m;
  const box = $('#composer-context');
  $('#composer-context-title').textContent = 'Editing message';
  $('#composer-context-text').textContent = m.text;
  box.hidden = false;
  const input = $('#composer-input');
  input.value = m.text;
  autosize(input);
  updateSendState();
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}

let pendingAttachments = [];

function renderAttachmentTray() {
  const tray = $('#attachment-tray');
  tray.innerHTML = '';
  tray.hidden = pendingAttachments.length === 0;
  for (const a of pendingAttachments) {
    const chip = document.createElement('div');
    chip.className = 'attachment-chip';
    chip.innerHTML = '<span class="attachment-chip-name"></span>';
    chip.querySelector('.attachment-chip-name').textContent = `${a.name} (${formatBytes(a.size)})`;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'btn icon-btn sm';
    remove.setAttribute('aria-label', `Remove ${a.name}`);
    remove.innerHTML = '<svg class="icon sm" aria-hidden="true"><use href="#i-x"/></svg>';
    remove.addEventListener('click', () => {
      pendingAttachments = pendingAttachments.filter((x) => x.id !== a.id);
      renderAttachmentTray();
      updateSendState();
    });
    chip.append(remove);
    tray.append(chip);
  }
}

async function addFiles(fileList) {
  if (!activeConvoId) return;
  const room = 4 - pendingAttachments.length;
  const files = [...fileList].slice(0, Math.max(room, 0));
  if (!files.length) { toast('Up to 4 files per message.', 'error'); return; }
  for (const file of files) {
    try {
      const uploaded = await db.uploadAttachment(activeConvoId, file);
      pendingAttachments.push(uploaded);
      renderAttachmentTray();
      updateSendState();
    } catch (err) {
      toast(`${file.name}: ${err.message}`, 'error');
    }
  }
}

function cancelComposeContext() {
  const wasEditing = !!editing;
  replyTo = null;
  editing = null;
  $('#composer-context').hidden = true;
  if (wasEditing) {
    const input = $('#composer-input');
    input.value = activeConvoId ? (db.convoMeta(me.id, activeConvoId).draft || '') : '';
    autosize(input);
    updateSendState();
  }
}

function sendCurrent() {
  const input = $('#composer-input');
  const text = input.value.trim();
  if ((!text && !pendingAttachments.length) || !activeConvoId) return;
  if (!text && editing) return;
  const convo = db.getConvo(activeConvoId);

  if (editing) {
    db.patchMessage(convo.id, editing.id, { text });
    editing = null;
    $('#composer-context').hidden = true;
  } else {
    db.appendMessage(convo.id, {
      text, replyTo: replyTo?.id, attachments: pendingAttachments,
    }).catch(() => { /* surfaced as a toast */ });
    pendingAttachments = [];
    renderAttachmentTray();
    db.markRead(convo.id, me.id);
    replyTo = null;
    $('#composer-context').hidden = true;
  }
  input.value = '';
  autosize(input);
  updateSendState();
  db.setConvoMeta(me.id, activeConvoId, { draft: '' });
  // The store event appends the new node; re-rendering here would throw away
  // every existing one for nothing.
  renderSidebar();
  input.focus();
}

function editLastOwnMessage() {
  if (!activeConvoId) return;
  const convo = db.getConvo(activeConvoId);
  const mine = visibleMessages(convo).filter((m) => m.from === me.id && !m.deletedAt);
  if (mine.length) startEdit(mine[mine.length - 1]);
}

/* ================= in-conversation search ================= */

function openConvoSearch() {
  $('#convo-search-bar').hidden = false;
  $('#btn-convo-search').setAttribute('aria-expanded', 'true');
  $('#convo-search-input').focus();
}

function closeConvoSearch() {
  convoSearch = null;
  $('#convo-search-bar').hidden = true;
  $('#convo-search-input').value = '';
  $('#convo-search-count').textContent = '';
  $('#btn-convo-search').setAttribute('aria-expanded', 'false');
  if (activeConvoId) renderMessages();
}

function runConvoSearch(q) {
  if (!q) { convoSearch = null; $('#convo-search-count').textContent = ''; renderMessages(); return; }
  // A match may be well above the window; searching must be able to reach it.
  renderWindow = Number.MAX_SAFE_INTEGER;
  const convo = db.getConvo(activeConvoId);
  const hits = visibleMessages(convo)
    .filter((m) => !m.deletedAt && m.text.toLowerCase().includes(q.toLowerCase()))
    .map((m) => m.id);
  convoSearch = { q, hits, idx: hits.length - 1 };
  updateConvoSearchCount();
  jumpToHit();
}

function updateConvoSearchCount() {
  const c = $('#convo-search-count');
  if (!convoSearch) { c.textContent = ''; return; }
  c.textContent = convoSearch.hits.length
    ? `${convoSearch.idx + 1} of ${convoSearch.hits.length}`
    : 'No matches';
}

function jumpToHit(step = 0) {
  if (!convoSearch?.hits.length) { renderMessages(); return; }
  const n = convoSearch.hits.length;
  convoSearch.idx = ((convoSearch.idx + step) % n + n) % n;
  pendingScrollMsg = convoSearch.hits[convoSearch.idx];
  updateConvoSearchCount();
  renderMessages();
}

/* ================= menus ================= */

let openMenuState = null; // { menu, button }

function toggleMenu(menu, button) {
  if (openMenuState?.menu === menu) { closeMenus(); return; }
  closeMenus();
  menu.hidden = false;
  button.setAttribute('aria-expanded', 'true');
  openMenuState = { menu, button };
  menu.querySelector('[role="menuitem"], button')?.focus();
}

function closeMenus() {
  if (openMenuState) {
    openMenuState.menu.hidden = true;
    openMenuState.button.setAttribute('aria-expanded', 'false');
    openMenuState = null;
  }
  closeReactPalette();
}

document.addEventListener('click', (e) => {
  if (openMenuState && !openMenuState.menu.contains(e.target) && !openMenuState.button.contains(e.target)) closeMenus();
  if (paletteEl && !paletteEl.contains(e.target) && !e.target.closest('.msg-actions')) closeReactPalette();
});

/* ================= settings UI ================= */

function buildThemeGrid() {
  const grid = $('#theme-grid');
  grid.innerHTML = '';
  const active = getSettings().theme;
  THEMES.forEach((t, i) => {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'theme-card';
    card.setAttribute('role', 'radio');
    card.setAttribute('aria-checked', String(t.id === active));
    card.tabIndex = t.id === active ? 0 : -1;
    card.dataset.themeId = t.id;
    card.innerHTML = `
      <span class="swatches" aria-hidden="true">${t.swatches.map((c) => `<span style="background:${c}"></span>`).join('')}</span>
      <span class="theme-name">${esc(t.name)}
        <svg class="icon sm check-mark" aria-hidden="true"><use href="#i-check"/></svg></span>
      <span class="theme-tag">${esc(t.tag)}</span>`;
    card.addEventListener('click', () => { setSetting('theme', t.id); buildThemeGrid(); });
    card.addEventListener('keydown', (e) => {
      const delta = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
      if (!delta) return;
      e.preventDefault();
      const next = THEMES[(i + delta + THEMES.length) % THEMES.length];
      setSetting('theme', next.id);
      buildThemeGrid();
      $(`[data-theme-id="${next.id}"]`, grid)?.focus();
    });
    grid.append(card);
  });
}

function buildAvatarColors() {
  const wrap = $('#avatar-colors');
  wrap.innerHTML = '';
  for (const color of AVATAR_COLORS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'avatar-swatch';
    b.style.background = color;
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(me.avatarColor === color));
    b.setAttribute('aria-label', `Avatar colour ${color}`);
    b.addEventListener('click', () => {
      db.updateProfile({ avatarColor: color }).then((updated) => {
        me = { ...me, ...updated };
        buildAvatarColors();
        renderOwnPreview();
        renderMe();
        renderSidebar();
      }).catch((err) => toast(err.message, 'error'));
    });
    wrap.append(b);
  }
}

function syncSettingsInputs() {
  const s = getSettings();
  for (const el of $$('[data-setting]')) {
    const key = el.dataset.setting;
    if (el.type === 'checkbox') el.checked = !!s[key];
    else el.value = s[key];
  }
  $('#out-font-scale').textContent = `${s.fontScale}%`;
  $('#out-line-height').textContent = s.lineHeight;
  $('#out-letter-spacing').textContent = `${s.letterSpacing}em`;
  buildThemeGrid();
  buildAvatarColors();
  fillProfileForm();
  $('#pin-status').textContent = me.hasPin ? 'Enabled for this account' : 'Not set';
  $('#btn-set-pin').textContent = me.hasPin ? 'Change PIN' : 'Set PIN';
  renderPasskeys();
  const pwRow = $('#btn-change-password').closest('.security-row');
  pwRow.hidden = !!me.isGuest;
  refreshStorageUsage();
  reflectPushState();
  renderBlockedList();
  reflectAdminEntry();
}

/**
 * The moderation link, built only for an administrator.
 *
 * The address comes from the server — `me.adminUrl`, sent only to accounts that
 * hold the flag — rather than being written into this file. index.html and this
 * script are both served to everyone, so a path hardcoded here would tell any
 * reader that a dashboard exists. Nothing is authorised on this side either
 * way: the server decides who gets the page.
 */
function reflectAdminEntry() {
  const entry = $('#admin-entry');
  if (!entry) return;
  entry.replaceChildren();
  if (!me.isAdmin || !me.adminUrl) return;

  const heading = document.createElement('h3');
  heading.textContent = 'Moderation';
  const intro = document.createElement('p');
  intro.className = 'hint';
  intro.textContent = 'You are an administrator on this server. Abuse reports are reviewed on a separate page.';

  const row = document.createElement('div');
  row.className = 'security-row';
  const label = document.createElement('div');
  const strong = document.createElement('strong');
  strong.textContent = 'Moderation dashboard';
  const sub = document.createElement('p');
  sub.className = 'hint';
  sub.textContent = 'Report queue, instance overview and the administrator audit log';
  label.append(strong, sub);

  const link = document.createElement('a');
  link.className = 'btn';
  link.href = me.adminUrl;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.innerHTML = '<svg class="icon sm" aria-hidden="true"><use href="#i-shield"/></svg>';
  link.append('Open');

  row.append(label, link);
  entry.append(heading, intro, row);
}

/**
 * The block list in Settings → Data & privacy.
 *
 * Once someone is blocked they are gone from search and from the conversation
 * list, so the profile card that holds the Unblock button is unreachable. This
 * is the way back.
 */
async function renderBlockedList() {
  const list = $('#blocked-list');
  list.innerHTML = '';
  let people;
  try {
    ({ blocked: people } = await db.blockedUsers());
  } catch {
    const li = document.createElement('li');
    li.className = 'hint';
    li.textContent = 'Could not load your block list.';
    list.append(li);
    return;
  }

  if (!people.length) {
    const li = document.createElement('li');
    li.className = 'hint';
    li.textContent = 'You have not blocked anyone.';
    list.append(li);
    return;
  }

  for (const user of people) {
    const row = document.createElement('li');
    row.className = 'member-row';
    const name = document.createElement('span');
    name.className = 'member-name';
    name.textContent = user.name;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn sm';
    btn.textContent = 'Unblock';
    btn.setAttribute('aria-label', `Unblock ${user.name}`);
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        await db.unblockUser(user.id);
        toast(`${user.name} is unblocked.`, 'success');
        renderBlockedList();
        renderSidebar();
      } catch (err) {
        toast(err.message, 'error');
        btn.disabled = false;
      }
    });
    row.append(avatarEl(user), name, btn);
    list.append(row);
  }
}

/** The stored preference and the browser's actual subscription can disagree —
    permission may have been revoked in site settings. Show what is true. */
async function reflectPushState() {
  const hint = $('#notif-permission-hint');
  const box = $('#set-desktop-notifs');
  if (!db.pushSupported()) {
    hint.hidden = false;
    hint.textContent = 'This browser cannot receive notifications while Relay is closed.';
    return;
  }
  if (!box.checked) { hint.hidden = true; return; }
  const live = await db.pushEnabled();
  hint.hidden = live;
  if (!live) {
    hint.textContent = 'Notifications are on, but this device is not registered for them yet — '
      + 'switch them off and on again to fix it.';
  }
}

async function renderPasskeys() {
  const status = $('#passkey-status');
  const btn = $('#btn-add-passkey');
  const list = $('#passkey-list');
  if (!db.passkeysSupported()) {
    status.textContent = 'Unavailable — passkeys need HTTPS or localhost.';
    btn.disabled = true;
    list.hidden = true;
    return;
  }
  btn.disabled = false;
  try {
    const { credentials } = await db.listPasskeys();
    status.textContent = credentials.length
      ? `${credentials.length} registered`
      : 'None registered yet';
    list.hidden = credentials.length === 0;
    list.innerHTML = '';
    for (const c of credentials) {
      const row = document.createElement('li');
      row.className = 'passkey-row';
      const label = document.createElement('span');
      const used = c.lastUsedAt ? `last used ${fmtDay(c.lastUsedAt)}` : 'never used';
      label.textContent = `${c.label || 'Passkey'} — added ${fmtDay(c.createdAt)}, ${used}`;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'btn sm';
      remove.textContent = 'Remove';
      remove.setAttribute('aria-label', `Remove ${c.label || 'passkey'}`);
      remove.addEventListener('click', async () => {
        if (!await confirmDialog('Remove passkey?', 'You will no longer be able to sign in with it.', 'Remove')) return;
        try { await db.deletePasskey(c.id); renderPasskeys(); toast('Passkey removed', 'success'); }
        catch (err) { toast(err.message, 'error'); }
      });
      row.append(label, remove);
      list.append(row);
    }
  } catch {
    status.textContent = 'Could not load your passkeys.';
  }
}

const PROFILE_FIELDS = {
  '#set-display-name': 'name',
  '#set-username': 'username',
  '#set-pronouns': 'pronouns',
  '#set-title': 'title',
  '#set-bio': 'bio',
  '#set-status-emoji': 'statusEmoji',
  '#set-status-text': 'statusText',
  '#set-timezone': 'timezone',
};

function fillProfileForm() {
  $('#set-display-name').value = me.name || '';
  $('#set-username').value = me.username || '';
  $('#set-pronouns').value = me.pronouns || '';
  $('#set-title').value = me.title || '';
  $('#set-bio').value = me.bio || '';
  $('#set-status-emoji').value = me.statusEmoji || '';
  $('#set-status-text').value = me.statusText || '';
  $('#set-timezone').value = me.timezone || '';
  updateBioCount();
  updateTzPreview();
  renderOwnPreview();
}

function updateBioCount() {
  $('#bio-remaining').textContent = String(280 - $('#set-bio').value.length);
}

function updateTzPreview() {
  const tz = $('#set-timezone').value.trim();
  const el = $('#tz-preview');
  if (!tz) { el.textContent = 'Not set — no local time is shown on your profile.'; return; }
  const now = localTimeIn(tz, getSettings().use24h);
  el.textContent = now ? `It is ${now} there right now.` : 'That time zone is not recognised.';
}

/** Live preview of the card other people will see. */
function renderOwnPreview() {
  const av = $('#own-avatar');
  av.style.setProperty('--av-bg', me.avatarColor || '#334155');
  av.textContent = initials($('#set-display-name').value || me.name);
  $('#own-preview-name').textContent = $('#set-display-name').value || me.name;
  const handle = $('#set-username').value.trim().replace(/^@+/, '');
  const meta = [
    handle ? `@${handle}` : '',
    $('#set-pronouns').value.trim(),
    $('#set-title').value.trim(),
  ].filter(Boolean);
  $('#own-preview-meta').textContent = meta.join(' · ');
  const status = `${$('#set-status-emoji').value.trim()} ${$('#set-status-text').value.trim()}`.trim();
  $('#own-preview-status').textContent = status;
}

function statusExpiryFromChoice() {
  const choice = $('#set-status-until').value;
  if (!choice) return null;
  if (choice === 'today') {
    const end = new Date();
    end.setHours(23, 59, 59, 999);
    return end.getTime();
  }
  return Date.now() + Number(choice) * 60000;
}

/**
 * Immediate feedback on the shape of a handle.
 *
 * Deliberately format-only. Whether a username is *free* is the server's
 * answer, given when you save — asking as you type would turn the form into a
 * way to test which handles exist, which is exactly the enumeration the
 * directory threshold is there to prevent.
 */
function checkUsernameFormat() {
  const input = $('#set-username');
  const value = input.value.trim().replace(/^@+/, '');
  if (value !== input.value) input.value = value;

  let problem = null;
  if (!value) problem = 'Choose a username.';
  else if (value.length < 3) problem = 'Usernames are at least 3 characters.';
  else if (!/^[A-Za-z0-9_]+$/.test(value)) problem = 'Letters, numbers and underscores only.';
  else if (!/[A-Za-z]/.test(value)) problem = 'Usernames need at least one letter.';

  input.setAttribute('aria-invalid', String(!!problem));
  if (problem) showErr('#username-error', problem);
  else hideErr('#username-error');
  return !problem;
}

async function saveProfile() {
  const btn = $('#btn-save-profile');
  hideErr('#profile-error');
  hideErr('#username-error');
  // The handle is the one field with a rule the server will reject outright;
  // catching it here saves a round trip and points at the right input.
  if (!checkUsernameFormat()) { $('#set-username').focus(); return; }
  btn.disabled = true;
  $('#profile-saved').textContent = '';
  try {
    const statusText = $('#set-status-text').value.trim();
    const updated = await db.updateProfile({
      name: $('#set-display-name').value,
      username: $('#set-username').value,
      pronouns: $('#set-pronouns').value,
      title: $('#set-title').value,
      bio: $('#set-bio').value,
      statusEmoji: $('#set-status-emoji').value,
      statusText,
      statusUntil: statusText ? statusExpiryFromChoice() : null,
      timezone: $('#set-timezone').value.trim() || null,
    });
    me = { ...me, ...updated };
    fillProfileForm();
    renderMe();
    renderSidebar();
    if (activeConvoId) renderConvoHeader();
    $('#profile-saved').textContent = 'Saved';
    setTimeout(() => { $('#profile-saved').textContent = ''; }, 2500);
  } catch (err) {
    // A rejected handle belongs beside the handle, not in the form-wide error.
    if (/username/i.test(err.message)) {
      showErr('#username-error', err.message);
      $('#set-username').setAttribute('aria-invalid', 'true');
      $('#set-username').focus();
    } else {
      showErr('#profile-error', err.message);
    }
  } finally {
    btn.disabled = false;
  }
}

/** Every route into a profile: the header, message avatars, your own avatar. */
function wireProfileOpeners() {
  // Conversation header — only meaningful for a direct conversation.
  const openHeaderProfile = () => {
    const convo = db.getConvo(activeConvoId);
    const other = convo && convoView(convo).other;
    if (other) openProfile(other.id);
  };
  for (const el of [$('#convo-avatar'), $('#convo-title')]) {
    el.addEventListener('click', openHeaderProfile);
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openHeaderProfile(); }
    });
  }

  // An avatar beside a message opens its author.
  $('#messages').addEventListener('click', (e) => {
    const av = e.target.closest('.avatar');
    if (!av) return;
    const msg = av.closest('.msg');
    if (!msg) return;
    const record = db.messagesOf(activeConvoId).find((m) => m.id === msg.dataset.msgId);
    if (record) openProfile(record.from);
  });

  // Your own profile from the account menu.
  $('#user-menu').addEventListener('click', (e) => {
    if (e.target.closest('[data-action="profile"]')) openProfile(me.id);
  });

  for (const btn of $$('[data-close-dialog]')) {
    btn.addEventListener('click', () => btn.closest('dialog')?.close());
  }

  $('#report-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!reportTarget) return;
    const btn = e.target.querySelector('button[type="submit"]');
    const reason = $('#report-form input[name="report-reason"]:checked')?.value;
    const alsoBlock = $('#report-also-block').checked;
    btn.disabled = true;
    try {
      await db.submitReport({ ...reportTarget, reason, note: $('#report-note').value.trim() });
      if (alsoBlock) await db.blockUser(reportTarget.subjectId);
      $('#report-dialog').close();
      renderSidebar();
      toast(alsoBlock ? 'Report sent, and they are blocked.' : 'Report sent. Thank you.', 'success');
    } catch (err) {
      showErr('#report-error', err.message);
    } finally {
      btn.disabled = false;
    }
  });
}

function wireProfilePanel() {
  for (const sel of Object.keys(PROFILE_FIELDS)) {
    $(sel).addEventListener('input', () => {
      renderOwnPreview();
      if (sel === '#set-bio') updateBioCount();
      if (sel === '#set-timezone') updateTzPreview();
      if (sel === '#set-username') checkUsernameFormat();
    });
  }
  $('#btn-save-profile').addEventListener('click', saveProfile);
  $('#btn-detect-tz').addEventListener('click', () => {
    const guess = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (!guess) return toast('This browser will not report a time zone.', 'error');
    $('#set-timezone').value = guess;
    updateTzPreview();
  });
  $('#btn-clear-status').addEventListener('click', async () => {
    $('#set-status-emoji').value = '';
    $('#set-status-text').value = '';
    $('#set-status-until').value = '';
    renderOwnPreview();
    await saveProfile();
  });
}

function refreshStorageUsage() {
  const convos = db.convosFor().length;
  const msgs = db.convosFor().reduce((n, c) => n + db.messagesOf(c.id).length, 0);
  $('#storage-usage').textContent = `${convos} conversations, ${msgs} messages stored on the server`;
}

function openSettings(panel = 'appearance') {
  syncSettingsInputs();
  switchSettingsPanel(panel);
  $('#settings-dialog').showModal();
}

function switchSettingsPanel(name) {
  for (const btn of $$('.settings-nav-item')) {
    const on = btn.dataset.panel === name;
    btn.setAttribute('aria-current', String(on));
  }
  for (const panel of $$('.settings-panel')) panel.hidden = panel.dataset.panel !== name;
  $('.settings-panels').scrollTop = 0;
}

function wireSettings() {
  $('#btn-settings').addEventListener('click', () => openSettings());
  $('#settings-close').addEventListener('click', () => $('#settings-dialog').close());
  for (const btn of $$('.settings-nav-item')) {
    btn.addEventListener('click', () => switchSettingsPanel(btn.dataset.panel));
  }

  for (const el of $$('[data-setting]')) {
    el.addEventListener(el.tagName === 'SELECT' || el.type === 'checkbox' ? 'change' : 'input', async () => {
      const key = el.dataset.setting;
      let value = el.type === 'checkbox' ? el.checked : el.value;
      if (el.type === 'range') value = Number(value);
      if (key === 'desktopNotifs') {
        if (value === true) {
          const ok = await ensureNotifPermission();
          if (!ok) { el.checked = false; return; }
          // Subscribing is what makes a notification arrive with the app closed.
          try {
            await db.enablePush();
            $('#notif-permission-hint').hidden = true;
          } catch (err) {
            $('#notif-permission-hint').hidden = false;
            $('#notif-permission-hint').textContent =
              `Notifications will work while Relay is open, but not when it is closed: ${err.message}`;
          }
        } else {
          await db.disablePush().catch(() => {});
        }
      }
      setSetting(key, value);
      if (key === 'fontScale') $('#out-font-scale').textContent = `${value}%`;
      if (key === 'lineHeight') $('#out-line-height').textContent = value;
      if (key === 'letterSpacing') $('#out-letter-spacing').textContent = `${value}em`;
      if (key === 'readReceipts') db.setReceiptsEnabled(value);
      if (key === 'use24h' || key === 'typingIndicators') { renderSidebar(); if (activeConvoId) renderMessages(); renderTyping(); }
    });
  }

  // PIN
  $('#btn-set-pin').addEventListener('click', () => {
    $('#pin-new').value = ''; $('#pin-confirm').value = '';
    hideErr('#pin-err');
    $('#pin-dialog').showModal();
  });
  $('#pin-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const a = $('#pin-new').value, b = $('#pin-confirm').value;
    if (!/^\d{4,6}$/.test(a)) return showErr('#pin-err', 'PIN must be 4–6 digits.');
    if (a !== b) return showErr('#pin-err', 'PINs do not match.');
    try {
      await db.setPin(a);
      me.hasPin = true;
      db.rememberDevice({ lastUserId: me.id, lastUserName: me.name, hasPin: true });
      $('#pin-dialog').close();
      syncSettingsInputs();
      toast('Quick-unlock PIN saved', 'success');
    } catch (err) { showErr('#pin-err', err.message); }
  });

  // Passkey


  // Password change
  $('#btn-change-password').addEventListener('click', () => {
    $('#pw-current').value = ''; $('#pw-new').value = '';
    hideErr('#pw-change-err');
    $('#password-dialog').showModal();
  });
  $('#password-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      if ($('#pw-new').value.length < 8) throw new Error('New password must be at least 8 characters.');
      await db.changePassword($('#pw-current').value, $('#pw-new').value);
      $('#password-dialog').close();
      toast('Password updated. Other devices have been signed out.', 'success');
      setTimeout(() => location.reload(), 1200);
    } catch (err) {
      showErr('#pw-change-err', err.message);
    }
  });

  $('#btn-add-passkey').addEventListener('click', async () => {
    const btn = $('#btn-add-passkey');
    btn.disabled = true;
    try {
      const label = `${navigator.platform || 'This device'}`.slice(0, 40);
      await db.registerPasskey(label);
      await renderPasskeys();
      toast('Passkey registered — try it on your next sign-in.', 'success');
    } catch (err) {
      if (err.name !== 'NotAllowedError' && err.name !== 'AbortError') {
        toast(err.message || 'Passkey registration failed.', 'error');
      }
    } finally {
      btn.disabled = false;
    }
  });

  $('#btn-signout').addEventListener('click', () => doSignOut());

  $('#btn-delete-account').addEventListener('click', async () => {
    if (await confirmDialog('Delete account?', 'Your profile, settings and conversation list are removed from this browser. This cannot be undone.', 'Delete account')) {
      try {
        await db.deleteAccount();
        db.forgetDevice();
        location.reload();
      } catch (err) { toast(err.message, 'error'); }
    }
  });

  // Data panel
  $('#btn-export-data').addEventListener('click', exportAllData);
  $('#btn-refresh-storage').addEventListener('click', refreshStorageUsage);
  $('#btn-reset-settings').addEventListener('click', () => {
    resetSettings();
    syncSettingsInputs();
    toast('Settings restored to defaults', 'success');
  });
  $('#btn-wipe').addEventListener('click', async () => {
    if (await confirmDialog('Delete your account?', 'Your account, messages and settings are permanently removed from the server. This cannot be undone.', 'Delete everything')) {
      try {
        await db.deleteAccount();
        db.forgetDevice();
        location.reload();
      } catch (err) { toast(err.message, 'error'); }
    }
  });

  for (const btn of $$('[data-close-dialog]')) {
    btn.addEventListener('click', () => btn.closest('dialog')?.close());
  }
}

/** A notification tapped while the app was closed asks us to open a chat. */
function wireNotificationOpens() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data?.type !== 'open-conversation') return;
    const convo = db.getConvo(e.data.convoId);
    if (convo) openConvo(convo.id);
  });

  // And the same via the URL, when a new window had to be launched.
  const wanted = new URLSearchParams(location.search).get('convo');
  if (wanted && db.getConvo(wanted)) {
    openConvo(wanted);
    // Leave a clean address bar behind.
    history.replaceState(null, '', location.pathname);
  }
}

async function ensureNotifPermission() {
  const hint = $('#notif-permission-hint');
  if (!('Notification' in window)) {
    hint.hidden = false;
    hint.textContent = 'This browser does not support desktop notifications.';
    return false;
  }
  if (Notification.permission === 'granted') return true;
  const res = await Notification.requestPermission();
  if (res !== 'granted') {
    hint.hidden = false;
    hint.textContent = 'Notifications are blocked by the browser. Allow them in site settings to use this.';
    return false;
  }
  hint.hidden = true;
  return true;
}

async function exportAllData() {
  try {
    const payload = await db.exportData();
    downloadFile(`relay-export-${new Date().toISOString().slice(0, 10)}.json`,
      'application/json', JSON.stringify(payload, null, 2));
    toast('Export downloaded', 'success');
  } catch (err) {
    toast(err.message, 'error');
  }
}

function exportConvoTxt() {
  const convo = db.getConvo(activeConvoId);
  if (!convo) return;
  const view = convoView(convo);
  const s = getSettings();
  const lines = visibleMessages(convo).map((m) => {
    const who = db.getUser(m.from)?.name || 'Unknown';
    const when = `${fmtDay(m.at)} ${fmtTime(m.at, s.use24h)}`;
    return m.deletedAt ? `[${when}] ${who}: (deleted)` : `[${when}] ${who}: ${m.text}`;
  });
  downloadFile(`relay-${view.title.replace(/\W+/g, '-').toLowerCase()}.txt`, 'text/plain', lines.join('\n'));
  toast('Conversation exported', 'success');
}

const showErr = (sel, msg) => { const el = $(sel); el.textContent = msg; el.hidden = false; };
const hideErr = (sel) => { const el = $(sel); el.textContent = ''; el.hidden = true; };

/* ================= new chat dialog ================= */

let groupMode = false;
let selected = new Set();

function openNewChat() {
  groupMode = false;
  selected = new Set();
  $('#new-chat-search').value = '';
  $('#group-name').value = '';
  $('#group-compose').hidden = true;
  $('#new-chat-toggle-group').setAttribute('aria-pressed', 'false');
  renderDirectory('');
  updateNewChatState();
  $('#new-chat-dialog').showModal();
  $('#new-chat-search').focus();
}

async function renderDirectory(q) {
  // Below the threshold nothing is sent anywhere: you get the people this
  // browser already knows, and the server is never told what you typed.
  if (searchTerm(q).length < DIRECTORY_MIN_QUERY) {
    paintDirectory(familiarPeople(), q, { pending: false, short: true });
    return;
  }
  // Cached matches appear immediately so typing stays responsive, then the
  // server's answer replaces them — that is what surfaces accounts this
  // browser has never seen.
  paintDirectory(searchPeople(q), q, { pending: true });
  const remote = await fetchPeople(q);
  if (remote === null) return;                       // superseded or offline
  if ($('#new-chat-search').value !== q) return;     // query moved on
  paintDirectory(mergePeople(remote, q), q, { pending: false });
}

function paintDirectory(people, q, { pending, short } = {}) {
  const list = $('#directory-list');
  list.innerHTML = '';

  // Say why the list is short rather than letting it look like the search
  // failed. Sits above the results, because there usually are some.
  if (short) {
    const note = document.createElement('p');
    note.className = 'dir-note';
    note.textContent = people.length
      ? `Type ${DIRECTORY_MIN_QUERY} or more characters to search everyone — by name or @username.`
      : `Search for someone by name or @username. Type at least ${DIRECTORY_MIN_QUERY} characters.`;
    list.append(note);
  }

  if (!people.length) {
    const empty = document.createElement('p');
    empty.className = 'convo-empty';
    empty.textContent = pending ? 'Searching…' : 'Nobody matches that search.';
    if (!short) list.append(empty);
    return;
  }
  let headed = null;
  for (const person of people) {
    // Before a search, split the list into your contacts and everyone else so
    // the people you actually talk to are reachable first.
    const bucket = db.isContact(me.id, person.id) ? 'Contacts' : 'Everyone else';
    if (short && bucket !== headed && people.some((p) => db.isContact(me.id, p.id))) {
      headed = bucket;
      const h = document.createElement('p');
      h.className = 'dir-heading';
      h.textContent = bucket;
      list.append(h);
    }

    const row = document.createElement('div');
    row.className = 'person-row';
    row.setAttribute('role', 'listitem');

    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'directory-item';
    if (groupMode) item.setAttribute('aria-pressed', String(selected.has(person.id)));
    const av = avatarEl(person);
    const dot = document.createElement('span');
    dot.className = 'presence-dot' + (db.isOnline(person) ? '' : ' off');
    av.append(dot);
    item.append(av);
    const body = document.createElement('div');
    body.innerHTML = '<div class="dir-name"></div><div class="dir-role"></div>';
    body.querySelector('.dir-name').textContent = person.name;
    body.querySelector('.dir-role').textContent = personSubtitle(person);
    const mark = document.createElement('span');
    mark.className = 'sel-mark';
    mark.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#i-check"/></svg>';
    item.append(body, mark);
    item.addEventListener('click', async () => {
      if (groupMode) {
        selected.has(person.id) ? selected.delete(person.id) : selected.add(person.id);
        item.setAttribute('aria-pressed', String(selected.has(person.id)));
        updateNewChatState();
      } else {
        $('#new-chat-dialog').close();
        const convo = await db.ensureDm(me.id, person.id);
        renderSidebar();
        openConvo(convo.id);
      }
    });
    row.append(item, contactToggleBtn(person));
    list.append(row);
  }
}

function updateNewChatState() {
  const count = $('#group-count');
  if (groupMode) {
    count.textContent = selected.size
      ? `${selected.size} ${selected.size === 1 ? 'person' : 'people'} selected`
      : 'Select at least two people.';
    $('#new-chat-start').disabled = selected.size < 2 || !$('#group-name').value.trim();
  } else {
    $('#new-chat-start').disabled = true; // single DMs start straight from the list
  }
}

function wireNewChat() {
  $('#btn-new-chat').addEventListener('click', openNewChat);
  $('#empty-new-chat').addEventListener('click', openNewChat);
  $('#new-chat-close').addEventListener('click', () => $('#new-chat-dialog').close());
  $('#new-chat-search').addEventListener('input', (e) => renderDirectory(e.target.value));
  $('#group-name').addEventListener('input', updateNewChatState);
  $('#new-chat-toggle-group').addEventListener('click', () => {
    groupMode = !groupMode;
    $('#new-chat-toggle-group').setAttribute('aria-pressed', String(groupMode));
    $('#group-compose').hidden = !groupMode;
    if (!groupMode) selected.clear();
    renderDirectory($('#new-chat-search').value);
    updateNewChatState();
    if (groupMode) $('#group-name').focus();
  });
  $('#new-chat-start').addEventListener('click', async () => {
    if (!groupMode || selected.size < 2) return;
    const title = $('#group-name').value.trim();
    try {
      const convo = await db.createGroup(title, [...selected]);
      $('#new-chat-dialog').close();
      renderSidebar();
      openConvo(convo.id);
      toast(`Group “${title}” created`, 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
  });
}

/* ================= incoming events ================= */

function handleIncoming(convoId, msg) {
  const convo = db.getConvo(convoId);
  if (!convo || !convo.members.includes(me.id)) return;
  const wrap = $('#messages');
  const stickToBottomBefore = convoId === activeConvoId
    && wrap.scrollHeight - wrap.scrollTop - wrap.clientHeight < 160;
  typingByConvo.delete(convoId);
  renderTyping();

  const author = db.getUser(msg.from);
  if (msg.from !== me.id) {
    const isActive = convoId === activeConvoId && document.hasFocus();
    if (isActive) {
      db.markRead(convoId, me.id);
    } else {
      const meta = db.convoMeta(me.id, convoId);
      if (!meta.muted) {
        playBlip();
        notify(author?.name || 'New message', msg.text.slice(0, 120));
      }
    }
    announce(`New message from ${author?.name || 'someone'}: ${msg.text.slice(0, 140)}`);
    // Delivery receipt for human-to-human chats (bots handle their own).
    if (!msg.deliveredAt && !author?.isBot) db.patchMessage(convoId, msg.id, { deliveredAt: Date.now() });
  }
  if (convoId === activeConvoId) {
    if (!appendMessageNode(msg)) renderMessages();
    else if (stickToBottomBefore) $('#messages').scrollTop = $('#messages').scrollHeight;
    updateJumpButton(msg.from !== me.id);
  }
  renderSidebar();
  refreshUnreadBadge();
}

function wireStoreEvents() {
  db.on('message', ({ convoId, msg }) => handleIncoming(convoId, msg));
  db.on('message-updated', ({ convoId, msg, previousId }) => {
    // One node changed; only fall back to a full render if it is not on screen
    // in a shape we can patch.
    if (convoId === activeConvoId && !patchMessageNode(msg, previousId)) renderMessages();
    renderSidebar();
  });
  db.on('reads', ({ convoId }) => {
    // Receipts change only the status icons on your own messages.
    if (convoId === activeConvoId) refreshOwnStatuses();
    renderSidebar();
    refreshUnreadBadge();
  });
  db.on('conversation-removed', ({ convoId }) => {
    if (convoId === activeConvoId) closeConvoToList();
    if ($('#group-dialog').open && groupDialogConvoId === convoId) $('#group-dialog').close();
    renderSidebar();
    refreshUnreadBadge();
  });
  db.on('queued', ({ message, count }) => {
    toast(count > 1 ? `${message} (${count} waiting)` : message, 'info');
    setConnectionBanner('offline');
  });
  db.on('outbox', ({ sent }) => {
    toast(sent === 1 ? 'Queued message sent.' : `${sent} queued messages sent.`, 'success');
    if (activeConvoId) renderMessages();
    renderSidebar();
  });
  db.on('history', ({ convoId }) => { if (convoId === activeConvoId) renderSidebar(); });
  db.on('typing', ({ convoId, userId, name }) => { if (userId !== me.id) showTyping(convoId, name); });
  db.on('contacts', () => {
    renderSidebar();
    if (activeConvoId) renderConvoHeader();
    if ($('#new-chat-dialog').open) renderDirectory($('#new-chat-search').value);
  });
  db.on('presence-changed', () => { renderSidebar(); if (activeConvoId) renderConvoHeader(); });
  db.on('conversations', () => renderSidebar());
  db.on('users', () => { renderSidebar(); if (activeConvoId) renderConvoHeader(); });
  db.on('error', ({ message }) => toast(message, 'error'));
  db.on('resynced', () => {
    renderSidebar();
    refreshUnreadBadge();
    if (!activeConvoId) return;
    // A block on either side takes the conversation away. Leaving it open would
    // show a thread you can no longer post to.
    if (db.getConvo(activeConvoId)) renderMessages();
    else closeConvoToList();
  });
  db.on('blocks', () => {
    renderSidebar();
    if ($('#new-chat-dialog').open) renderDirectory($('#new-chat-search').value);
  });

  // A dropped stream means we may have missed events; resync on the way back.
  let wasDown = false;
  db.on('connection', ({ status }) => {
    setConnectionBanner(status);
    if (status === 'reconnecting') wasDown = true;
    else if (status === 'online' && wasDown) { wasDown = false; db.resync().catch(() => {}); }
  });

  window.addEventListener('focus', () => {
    if (activeConvoId) {
      db.markRead(activeConvoId, me.id);
      renderSidebar();
    }
    refreshUnreadBadge();
  });
}

function setConnectionBanner(status) {
  const el = $('#connection-banner');
  if (!el) return;
  const queued = db.outboxCount();
  // Being offline matters more when it is holding something you wrote.
  if (status === 'online' && !queued) { el.hidden = true; el.textContent = ''; return; }
  el.hidden = false;
  el.textContent = queued
    ? `Offline — ${queued} message${queued === 1 ? '' : 's'} waiting to send`
    : 'Reconnecting…';
}

/* ================= keyboard shortcuts ================= */

function isEditable(el) {
  return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
}

function wireShortcuts() {
  document.addEventListener('keydown', (e) => {
    const s = getSettings();
    if (e.key === 'Escape') {
      closeMenus();
      if (!$('#convo-search-bar').hidden) { closeConvoSearch(); return; }
      if (!$('#composer-context').hidden) { cancelComposeContext(); return; }
      if ($('#global-search').value) { clearGlobalSearch(); return; }
      return;
    }
    if (!s.shortcutsEnabled) return;
    const mod = e.ctrlKey || e.metaKey;

    if (mod && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      $('#global-search').focus();
      $('#global-search').select();
      return;
    }
    if (mod && e.key === ',') {
      e.preventDefault();
      openSettings();
      return;
    }
    if (e.altKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      const convos = myConvos();
      if (!convos.length) return;
      const idx = convos.findIndex((c) => c.id === activeConvoId);
      const next = e.key === 'ArrowDown'
        ? convos[Math.min(idx + 1, convos.length - 1)] || convos[0]
        : convos[Math.max(idx - 1, 0)] || convos[0];
      if (next && next.id !== activeConvoId) openConvo(next.id);
      return;
    }
    if (e.altKey && e.key.toLowerCase() === 'n') {
      e.preventDefault();
      openNewChat();
      return;
    }
    if (e.key === '?' && !isEditable(e.target)) {
      e.preventDefault();
      openSettings('about');
    }
  });
}

/* ================= topbar / self ================= */

function renderMe() {
  const av = $('#me-avatar');
  av.style.setProperty('--av-bg', me.avatarColor || '#334155');
  av.textContent = initials(me.name);
  $('#user-menu-header').innerHTML = '<strong></strong><span></span>';
  $('#user-menu-header strong').textContent = me.name;
  $('#user-menu-header span').textContent = me.email || 'Guest session';
}

async function doSignOut() {
  // The server retires a guest who chatted and removes one who did not, so
  // nobody is left with a conversation attributed to a missing user.
  try { await db.signOut(); } catch { /* sign out locally regardless */ }
  if (!$('#remember-me')?.checked) db.forgetDevice();
  signOutCb?.();
}

function wireTopbar() {
  $('#btn-user-menu').addEventListener('click', () => toggleMenu($('#user-menu'), $('#btn-user-menu')));
  $('#user-menu').addEventListener('click', (e) => {
    const action = e.target.closest('[role="menuitem"]')?.dataset.action;
    if (!action) return;
    closeMenus();
    if (action === 'open-settings') openSettings();
    if (action === 'shortcuts') openSettings('about');
    if (action === 'feedback') openFeedback();
    if (action === 'signout') doSignOut();
  });
  $('#global-search').addEventListener('input', debounce((e) => renderGlobalSearch(e.target.value.trim()), 150));

  for (const tab of $$('.sidebar-tabs [role="tab"]')) {
    tab.addEventListener('click', () => {
      filter = tab.dataset.filter;
      for (const t of $$('.sidebar-tabs [role="tab"]')) t.setAttribute('aria-selected', String(t === tab));
      renderSidebar();
    });
  }
}

/* ================= convo pane wiring ================= */

function wireConvoPane() {
  $('#btn-back').addEventListener('click', closeConvoToList);
  $('#btn-convo-pin').addEventListener('click', () => {
    const meta = db.convoMeta(me.id, activeConvoId);
    db.setConvoMeta(me.id, activeConvoId, { pinned: !meta.pinned });
    renderConvoHeader();
    renderSidebar();
  });
  $('#btn-convo-search').addEventListener('click', () => {
    $('#convo-search-bar').hidden ? openConvoSearch() : closeConvoSearch();
  });
  $('#convo-search-input').addEventListener('input', debounce((e) => runConvoSearch(e.target.value.trim()), 200));
  $('#convo-search-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); jumpToHit(e.shiftKey ? -1 : 1); }
  });
  $('#search-prev').addEventListener('click', () => jumpToHit(-1));
  $('#search-next').addEventListener('click', () => jumpToHit(1));
  $('#search-close').addEventListener('click', closeConvoSearch);

  $('#btn-convo-more').addEventListener('click', () => toggleMenu($('#convo-menu'), $('#btn-convo-more')));
  $('#convo-menu').addEventListener('click', async (e) => {
    const action = e.target.closest('[role="menuitem"]')?.dataset.action;
    if (!action) return;
    closeMenus();
    const meta = db.convoMeta(me.id, activeConvoId);
    if (action === 'contact') {
      const other = convoView(db.getConvo(activeConvoId)).other;
      if (other) {
        const had = db.isContact(me.id, other.id);
        if (had) db.removeContact(me.id, other.id);
        else db.addContact(me.id, other.id);
        renderConvoHeader();
        toast(had ? `${other.name} removed from contacts` : `${other.name} added to contacts`, 'success');
      }
    }
    if (action === 'group-details') openGroupDialog(activeConvoId);
    if (action === 'mute') {
      db.setConvoMeta(me.id, activeConvoId, { muted: !meta.muted });
      renderConvoHeader();
      toast(meta.muted ? 'Notifications unmuted' : 'Notifications muted', 'success');
    }
    if (action === 'export') exportConvoTxt();
    if (action === 'mark-read') { db.markRead(activeConvoId, me.id); renderSidebar(); }
    if (action === 'clear') {
      if (await confirmDialog('Clear history?', 'Hides all existing messages in this conversation for you. Others keep their copy.', 'Clear')) {
        db.setConvoMeta(me.id, activeConvoId, { clearedBefore: Date.now() });
        renderMessages();
        renderSidebar();
      }
    }
  });

  $('#jump-latest').addEventListener('click', () => {
    const wrap = $('#messages');
    wrap.scrollTop = wrap.scrollHeight;
    updateJumpButton();
  });
  $('#messages').addEventListener('scroll', debounce(() => updateJumpButton(), 100));

  // Composer
  const input = $('#composer-input');
  $('#composer').addEventListener('submit', (e) => { e.preventDefault(); sendCurrent(); });
  input.addEventListener('input', () => {
    autosize(input);
    updateSendState();
    if (!editing) saveDraft();
    broadcastTyping();
  });
  input.addEventListener('keydown', (e) => {
    const s = getSettings();
    if (e.key === 'Enter' && !e.shiftKey) {
      const sendNow = s.enterToSend ? !e.ctrlKey : e.ctrlKey;
      if (sendNow) { e.preventDefault(); sendCurrent(); }
    } else if (e.key === 'ArrowUp' && !input.value) {
      e.preventDefault();
      editLastOwnMessage();
    }
  });
  $('#composer-context-close').addEventListener('click', cancelComposeContext);

  // Attachments: button, paste and drag-and-drop all land in the same place.
  const fileInput = $('#file-input');
  $('#btn-attach').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => { addFiles(fileInput.files); fileInput.value = ''; });

  input.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) { e.preventDefault(); addFiles(files); }
  });

  const dropZone = $('#convo');
  let dragDepth = 0;
  dropZone.addEventListener('dragenter', (e) => {
    if (!e.dataTransfer?.types.includes('Files')) return;
    e.preventDefault();
    dragDepth += 1;
    dropZone.classList.add('drop-target');
  });
  dropZone.addEventListener('dragover', (e) => {
    if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
  });
  dropZone.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) dropZone.classList.remove('drop-target');
  });
  dropZone.addEventListener('drop', (e) => {
    if (!e.dataTransfer?.files.length) return;
    e.preventDefault();
    dragDepth = 0;
    dropZone.classList.remove('drop-target');
    addFiles(e.dataTransfer.files);
  });

  // Emoji picker
  const emojiMenu = $('#emoji-menu');
  emojiMenu.innerHTML = EMOJI_SET.map((e) => `<button type="button" aria-label="Insert ${e}">${e}</button>`).join('');
  $('#btn-emoji').addEventListener('click', () => toggleMenu(emojiMenu, $('#btn-emoji')));
  emojiMenu.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const emoji = b.textContent;
    const start = input.selectionStart ?? input.value.length;
    input.value = input.value.slice(0, start) + emoji + input.value.slice(input.selectionEnd ?? start);
    input.focus();
    input.selectionStart = input.selectionEnd = start + emoji.length;
    autosize(input);
    updateSendState();
    closeMenus();
  });
}

/* ================= entry point ================= */

export function initUI(user, { onSignOut } = {}) {
  me = user;
  signOutCb = onSignOut;
  loadSettings(me.id, db.initialSettings());
  applySettings();
  db.setReceiptsEnabled(getSettings().readReceipts);

  $('#auth-screen').hidden = true;
  $('#chat-screen').hidden = false;
  $('#chat-screen').dataset.mobileView = 'list';

  renderMe();
  renderSidebar();
  wireTopbar();
  wireConvoPane();
  wireSettings();
  wireNewChat();
  wireProfilePanel();
  wireProfileOpeners();
  wireStoreEvents();
  wireShortcuts();
  wireMessageKeys();
  wireTouchMessageActions();
  wireVisualViewport();
  wireGroupDialog();
  wireFeedback();
  wireNotificationOpens();
  db.connect();
  db.watchConnectivity();
  db.watchPresence();
  db.flushOutbox().catch(() => {});
  refreshUnreadBadge();
  announce(`Signed in as ${me.name}. ${myConvos().length} conversations.`);
}

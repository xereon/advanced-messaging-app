// Guards the optimistic-send reconciliation that produced duplicate bubbles.
//
// The client shows a message the instant you press Enter, under a temporary
// id, then reconciles it against the server's copy. Two things can confirm it:
// the send's own response, and the live SSE echo. Either may arrive first. If
// the echo is not recognised as the pending message coming home, the message
// is rendered a second time and appears to have been sent twice.
//
// store.js needs a DOM to import, so the reconciliation rule is reproduced
// here exactly and asserted against every arrival order.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/** Mirror of upsertMessage in public/js/store.js. */
function upsert(list, msg, clientId) {
  let replacedId = null;
  let i = clientId ? list.findIndex((m) => m.id === clientId) : -1;
  if (i !== -1) replacedId = clientId;
  if (i === -1) i = list.findIndex((m) => m.id === msg.id);
  if (i === -1) {
    list.push(msg);
    list.sort((a, b) => a.at - b.at || (a.seq ?? 0) - (b.seq ?? 0));
  } else {
    list[i] = { ...list[i], ...msg, pending: false, failed: false };
  }
  return { replacedId };
}

/** Mirror of the SSE 'message' handler's routing decision. */
function routeEcho(list, message, clientId) {
  const existing = list.some((m) => m.id === message.id);
  const { replacedId } = upsert(list, message, clientId);
  return (existing || replacedId)
    ? { event: 'message-updated', previousId: replacedId }
    : { event: 'message', previousId: null };
}

const CLIENT_ID = 'pending-abc';
const SERVER_MSG = { id: 'm-real', convoId: 'c1', from: 'u1', text: 'hello', at: 1000, seq: 7 };
const optimistic = () => ([{ id: CLIENT_ID, convoId: 'c1', from: 'u1', text: 'hello', at: 1000, pending: true }]);

describe('optimistic send reconciliation', () => {
  test('the send response confirms the pending message in place', () => {
    const list = optimistic();
    const { replacedId } = upsert(list, SERVER_MSG, CLIENT_ID);
    assert.equal(list.length, 1, 'must not become two messages');
    assert.equal(list[0].id, 'm-real');
    assert.equal(list[0].pending, false);
    assert.equal(replacedId, CLIENT_ID, 'the caller needs the id it replaced to re-key the bubble');
  });

  test('the echo arriving first is an update, not a new arrival', () => {
    const list = optimistic();
    const routed = routeEcho(list, SERVER_MSG, CLIENT_ID);
    assert.equal(list.length, 1, 'the echo must not add a second message');
    assert.equal(routed.event, 'message-updated', 'routing it as an arrival appends a duplicate bubble');
    assert.equal(routed.previousId, CLIENT_ID, 'the pending bubble must be replaceable by id');
  });

  test('echo first, then the send response — still one message', () => {
    const list = optimistic();
    routeEcho(list, SERVER_MSG, CLIENT_ID);
    const { replacedId } = upsert(list, SERVER_MSG, CLIENT_ID);
    assert.equal(list.length, 1);
    assert.equal(replacedId, null, 'nothing pending left to replace the second time');
  });

  test('send response first, then the echo — still one message', () => {
    const list = optimistic();
    upsert(list, SERVER_MSG, CLIENT_ID);
    const routed = routeEcho(list, SERVER_MSG, CLIENT_ID);
    assert.equal(list.length, 1);
    assert.equal(routed.event, 'message-updated');
  });

  test('a duplicate echo is idempotent', () => {
    const list = optimistic();
    routeEcho(list, SERVER_MSG, CLIENT_ID);
    routeEcho(list, SERVER_MSG, CLIENT_ID);
    routeEcho(list, SERVER_MSG, CLIENT_ID);
    assert.equal(list.length, 1, 'replayed events must not multiply the message');
  });

  test("someone else's message is a genuine arrival", () => {
    const list = optimistic();
    const theirs = { id: 'm-other', convoId: 'c1', from: 'u2', text: 'hi back', at: 1001, seq: 8 };
    const routed = routeEcho(list, theirs, undefined);
    assert.equal(routed.event, 'message', 'must still render as a new message');
    assert.equal(list.length, 2);
  });

  test('an echo for another device of the same account is not swallowed', () => {
    // Sent from a phone; this tab has no pending row for that clientId.
    const list = optimistic();
    const fromPhone = { id: 'm-phone', convoId: 'c1', from: 'u1', text: 'from my phone', at: 1002, seq: 9 };
    const routed = routeEcho(list, fromPhone, 'pending-on-the-phone');
    assert.equal(routed.event, 'message');
    assert.equal(list.length, 2);
  });

  test('messages stay in order after reconciling', () => {
    const list = optimistic();
    upsert(list, { id: 'm-early', convoId: 'c1', from: 'u2', text: 'earlier', at: 500, seq: 5 });
    upsert(list, SERVER_MSG, CLIENT_ID);
    assert.deepEqual(list.map((m) => m.id), ['m-early', 'm-real']);
  });
});

describe('the shipped code matches the rule tested here', () => {
  const store = readFileSync(new URL('../public/js/store.js', import.meta.url), 'utf8');
  const ui = readFileSync(new URL('../public/js/ui.js', import.meta.url), 'utf8');

  test('upsertMessage reports the id it replaced', () => {
    assert.match(store, /return \{ msg, replacedId \}/);
  });

  test('the echo handler routes a reconciled message as an update', () => {
    assert.match(store, /if \(existing \|\| replacedId\)/);
    assert.match(store, /previousId: replacedId/);
  });

  test('the renderer looks the bubble up by its previous id', () => {
    assert.match(ui, /function patchMessageNode\(msg, previousId\)/);
    assert.match(ui, /CSS\.escape\(previousId \|\| msg\.id\)/);
  });

  test('orphaned nodes are swept before appending', () => {
    assert.match(ui, /if \(!live\.has\(node\.dataset\.msgId\)\) node\.remove\(\)/);
  });
});

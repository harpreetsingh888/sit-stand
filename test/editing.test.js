import test from 'node:test';
import assert from 'node:assert/strict';

import { openDatabase } from '../lib/db.js';

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 8, 7, 9, 0, 0);

/** A store holding three back-to-back sessions and one still open. */
function storeWithDay() {
  const store = openDatabase();
  store.unsafeInsertSession({ posture: 'sit', started_at: T0, ended_at: T0 + 2 * HOUR });
  store.unsafeInsertSession({ posture: 'stand', started_at: T0 + 2 * HOUR, ended_at: T0 + 3 * HOUR });
  store.unsafeInsertSession({ posture: 'sit', started_at: T0 + 3 * HOUR, ended_at: null });
  return store;
}

const codeOf = (fn) => {
  try {
    fn();
    return null;
  } catch (error) {
    return error.code ?? error.constructor.name;
  }
};

test('a single session can be read back by id', () => {
  const store = storeWithDay();
  assert.equal(store.session(2).posture, 'stand');
  assert.equal(store.session(999), null);
  store.close();
});

/* ------------------------------------------------------------------ editing */

test('a session posture can be corrected', () => {
  const store = storeWithDay();
  const updated = store.updateSession(1, { posture: 'stand' });

  assert.equal(updated.posture, 'stand');
  assert.equal(updated.started_at, T0, 'the boundaries are untouched');
  assert.equal(updated.ended_at, T0 + 2 * HOUR);
  store.close();
});

test('a boundary can be moved within the space its neighbours leave', () => {
  const store = storeWithDay();
  const updated = store.updateSession(2, {
    started_at: T0 + 2.5 * HOUR,
    ended_at: T0 + 2.75 * HOUR,
  });

  assert.equal(updated.started_at, T0 + 2.5 * HOUR);
  assert.equal(updated.ended_at, T0 + 2.75 * HOUR);
  store.close();
});

test('an edit that would overlap a neighbour is refused', () => {
  const store = storeWithDay();
  assert.equal(codeOf(() => store.updateSession(2, { started_at: T0 + HOUR })), 'OVERLAP');
  assert.equal(codeOf(() => store.updateSession(2, { ended_at: T0 + 4 * HOUR })), 'OVERLAP');

  assert.equal(store.session(2).started_at, T0 + 2 * HOUR, 'nothing changed');
  store.close();
});

test('an edit that reverses a session is refused', () => {
  const store = storeWithDay();
  assert.equal(
    codeOf(() => store.updateSession(2, { started_at: T0 + 2.9 * HOUR, ended_at: T0 + 2.1 * HOUR })),
    'INVALID',
  );
  store.close();
});

test('an unknown posture or unknown session is refused', () => {
  const store = storeWithDay();
  assert.equal(codeOf(() => store.updateSession(1, { posture: 'hovering' })), 'INVALID');
  assert.equal(codeOf(() => store.updateSession(404, { posture: 'sit' })), 'NOT_FOUND');
  store.close();
});

test('the open session can be closed by editing it', () => {
  const store = storeWithDay();
  store.updateSession(3, { ended_at: T0 + 4 * HOUR });

  assert.equal(store.currentSession(), null);
  assert.equal(store.session(3).ended_at, T0 + 4 * HOUR);
  store.close();
});

test('editing cannot open a second session', () => {
  const store = storeWithDay();
  assert.ok(codeOf(() => store.updateSession(1, { ended_at: null })));
  assert.equal(store.allSessions().filter((s) => s.ended_at === null).length, 1);
  store.close();
});

/* ---------------------------------------------------------------- splitting */

test('splitting records a posture you forgot to switch to', () => {
  const store = storeWithDay();
  const parts = store.splitSession(1, T0 + HOUR, 'stand');

  assert.deepEqual(parts.map((s) => s.posture), ['sit', 'stand']);
  assert.equal(parts[0].started_at, T0);
  assert.equal(parts[0].ended_at, T0 + HOUR);
  assert.equal(parts[1].started_at, T0 + HOUR, 'the halves stay contiguous');
  assert.equal(parts[1].ended_at, T0 + 2 * HOUR);
  assert.equal(store.allSessions().length, 4);
  store.close();
});

test('splitting the open session leaves the later half open', () => {
  const store = storeWithDay();
  const parts = store.splitSession(3, T0 + 3.5 * HOUR, 'stand');

  assert.equal(parts[0].ended_at, T0 + 3.5 * HOUR);
  assert.equal(parts[1].ended_at, null);
  assert.equal(store.currentSession().id, parts[1].id);
  store.close();
});

test('a split outside the session, or at either edge, is refused', () => {
  const store = storeWithDay();
  for (const at of [T0 - HOUR, T0, T0 + 2 * HOUR, T0 + 5 * HOUR]) {
    assert.equal(codeOf(() => store.splitSession(1, at, 'stand')), 'INVALID', `at ${at}`);
  }
  assert.equal(store.allSessions().length, 3, 'nothing was written');
  store.close();
});

test('splitting into the same posture is refused as a no-op', () => {
  const store = storeWithDay();
  assert.equal(codeOf(() => store.splitSession(1, T0 + HOUR, 'sit')), 'INVALID');
  store.close();
});

/* ---------------------------------------------------- deleting and inserting */

test('a session can be deleted, leaving a gap', () => {
  const store = storeWithDay();
  store.deleteSession(2);

  assert.deepEqual(store.allSessions().map((s) => s.id), [1, 3]);
  assert.equal(store.session(1).ended_at, T0 + 2 * HOUR, 'neighbours are left alone');
  assert.equal(store.session(3).started_at, T0 + 3 * HOUR);
  store.close();
});

test('deleting something that is not there says so', () => {
  const store = storeWithDay();
  assert.equal(codeOf(() => store.deleteSession(404)), 'NOT_FOUND');
  store.close();
});

test('a missing block can be added into a gap', () => {
  const store = storeWithDay();
  store.deleteSession(2);
  const added = store.insertSession({
    posture: 'away',
    started_at: T0 + 2 * HOUR,
    ended_at: T0 + 3 * HOUR,
  });

  assert.equal(added.posture, 'away');
  assert.deepEqual(
    store.allSessions().map((s) => s.posture),
    ['sit', 'away', 'sit'],
    'ordered by start time, so the new block sits between the other two',
  );
  store.close();
});

test('a block that would overlap an existing one is refused', () => {
  const store = storeWithDay();
  assert.equal(
    codeOf(() => store.insertSession({
      posture: 'away',
      started_at: T0 + HOUR,
      ended_at: T0 + 2.5 * HOUR,
    })),
    'OVERLAP',
  );
  assert.equal(store.allSessions().length, 3);
  store.close();
});

test('every edit keeps the one-open-session guarantee', () => {
  const store = storeWithDay();
  store.updateSession(1, { posture: 'away' });
  store.splitSession(2, T0 + 2.5 * HOUR, 'sit');
  store.deleteSession(1);
  store.insertSession({ posture: 'stand', started_at: T0, ended_at: T0 + HOUR });

  assert.equal(store.allSessions().filter((s) => s.ended_at === null).length, 1);
  store.close();
});

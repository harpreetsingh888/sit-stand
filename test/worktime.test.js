import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';

import { createRequestHandler } from '../lib/api.js';
import { openDatabase } from '../lib/db.js';
import { closeStrandedSessions } from '../lib/worktime.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

// Monday the 7th and Tuesday the 8th of September 2026.
const on = (date, hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(2026, 8, date, h, m, 0, 0).getTime();
};

async function startServer(t, now) {
  const clock = { ms: now };
  const store = openDatabase();
  const server = http.createServer(createRequestHandler({ store, now: () => clock.ms }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;

  t.after(async () => {
    server.close();
    await once(server, 'close');
    store.close();
  });

  const call = async (path, method = 'GET', payload) => {
    const response = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json' },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
    return { status: response.status, body: await response.json() };
  };
  return { clock, store, call };
}

/* ------------------------------------------------- toggling at a given time */

test('a toggle can name the moment it actually happened', async (t) => {
  const { call, clock } = await startServer(t, on(7, '11:00'));
  await call('/api/toggle', 'POST', { posture: 'sit' });

  clock.ms = on(7, '12:00');
  // The Mac slept at 11:30; we are only telling the tracker now.
  const { body } = await call('/api/toggle', 'POST', {
    posture: 'away',
    at: on(7, '11:30'),
  });

  assert.equal(body.data.session.started_at, on(7, '11:30'));
  assert.equal(body.data.today.sit, 30 * MINUTE, 'sitting stopped at 11:30, not at noon');
});

test('a toggle cannot be dated into the future', async (t) => {
  const { call } = await startServer(t, on(7, '11:00'));
  const { body } = await call('/api/toggle', 'POST', {
    posture: 'sit',
    at: on(7, '15:00'),
  });
  assert.equal(body.data.session.started_at, on(7, '11:00'), 'clamped back to now');
});

test('a toggle cannot be dated before the block it is ending', async (t) => {
  const { call, clock } = await startServer(t, on(7, '11:00'));
  await call('/api/toggle', 'POST', { posture: 'sit' });

  clock.ms = on(7, '12:00');
  const { body } = await call('/api/toggle', 'POST', {
    posture: 'stand',
    at: on(7, '09:00'),
  });
  assert.equal(body.data.session.started_at, on(7, '11:00'), 'clamped to the open block');
});

test('a nonsense timestamp is refused', async (t) => {
  const { call } = await startServer(t, on(7, '11:00'));
  const { status, body } = await call('/api/toggle', 'POST', { posture: 'sit', at: 'lunchtime' });
  assert.equal(status, 400);
  assert.match(body.error.message, /at/i);
});

/* --------------------------------------------- the working day ends by itself */

test('a block left open past the end of the day is closed at the end of the day', () => {
  const store = openDatabase();
  const settings = store.getSettings(); // 09:00-18:00, Mon-Fri
  store.setPosture('sit', on(7, '16:00'));

  const closed = closeStrandedSessions(store, settings, on(8, '10:00'));

  assert.equal(closed.length, 1);
  assert.equal(store.currentSession(), null, 'nothing is left running');
  assert.equal(store.allSessions()[0].ended_at, on(7, '18:00'));
  store.close();
});

test('a block open during today is left alone', () => {
  const store = openDatabase();
  store.setPosture('sit', on(7, '10:00'));

  const closed = closeStrandedSessions(store, store.getSettings(), on(7, '11:00'));

  assert.deepEqual(closed, []);
  assert.equal(store.currentSession().posture, 'sit');
  store.close();
});

test('a block is closed once the working day is over, without waiting for tomorrow', () => {
  const store = openDatabase();
  store.setPosture('stand', on(7, '17:30'));

  closeStrandedSessions(store, store.getSettings(), on(7, '18:20'));

  assert.equal(store.currentSession(), null);
  assert.equal(store.allSessions()[0].ended_at, on(7, '18:00'));
  store.close();
});

test('a block that began on a day off is closed when that day is over', () => {
  const store = openDatabase();
  // Saturday: there is no working window, so the calendar day ends it.
  store.setPosture('sit', on(12, '10:00'));

  closeStrandedSessions(store, store.getSettings(), on(14, '09:30'));

  assert.equal(store.currentSession(), null);
  assert.equal(store.allSessions()[0].ended_at, on(13, '00:00'));
  store.close();
});

test('a block started deliberately after hours is left running that evening', () => {
  const store = openDatabase();
  store.setPosture('sit', on(7, '20:00'));

  assert.deepEqual(closeStrandedSessions(store, store.getSettings(), on(7, '21:00')), []);
  assert.equal(store.currentSession().posture, 'sit', 'the button is not made to look broken');

  closeStrandedSessions(store, store.getSettings(), on(8, '09:00'));
  assert.equal(store.currentSession(), null, 'but it does not run into the next day');
  store.close();
});

test('nothing is closed when the automatic stop is turned off', () => {
  const store = openDatabase();
  const settings = { ...store.getSettings(), autoStopAtWorkEnd: false };
  store.setPosture('sit', on(7, '16:00'));

  assert.deepEqual(closeStrandedSessions(store, settings, on(8, '10:00')), []);
  assert.equal(store.currentSession().posture, 'sit');
  store.close();
});

test('closing a stranded block is safe to run repeatedly', () => {
  const store = openDatabase();
  store.setPosture('sit', on(7, '16:00'));

  closeStrandedSessions(store, store.getSettings(), on(8, '10:00'));
  const second = closeStrandedSessions(store, store.getSettings(), on(8, '10:05'));

  assert.deepEqual(second, []);
  assert.equal(store.allSessions().length, 1);
  store.close();
});

test('the server reports when it closed the working day for you', async (t) => {
  const { call, store, clock } = await startServer(t, on(7, '16:00'));
  await call('/api/toggle', 'POST', { posture: 'sit' });

  clock.ms = on(8, '09:30');
  const { body } = await call('/api/state');

  assert.equal(body.data.session, null, 'yesterday was closed off');
  assert.equal(store.allSessions()[0].ended_at, on(7, '18:00'));
});

/* ------------------------------------- the Mac sleeping across a day change */

/**
 * The sequence the menu bar app performs, exercised against the real API.
 * Sleeping at 17:00 on the 1st and waking at 10:00 on the 2nd must leave the
 * 1st ending at 17:00, with nothing started for the 2nd.
 */
test('sleeping through to the next day ends the previous day where it slept', async (t) => {
  const { call, clock } = await startServer(t, on(7, '16:00'));
  await call('/api/toggle', 'POST', { posture: 'sit' });

  // 17:00: the Mac is going to sleep and says so.
  clock.ms = on(7, '17:00');
  const away = await call('/api/toggle', 'POST', { posture: 'away', at: on(7, '17:00') });
  const awayId = away.body.data.session.id;
  assert.equal(away.body.data.session.posture, 'away');

  // 10:00 the next morning: a different day, so the absence is taken back out.
  clock.ms = on(8, '10:00');
  const after = await call(`/api/sessions/${awayId}`, 'DELETE');

  assert.equal(after.status, 200);
  const { body } = await call('/api/state');
  assert.equal(body.data.session, null, 'nothing is tracking; you press start yourself');
  assert.equal(body.data.today.sit, 0, 'and the new day is empty');

  const yesterday = await call(`/api/day?day=2026-09-07`);
  assert.deepEqual(yesterday.body.data.sessions.map((s) => s.posture), ['sit']);
  assert.equal(yesterday.body.data.sessions[0].ended_at, on(7, '17:00'), 'ends when it slept');
  assert.equal(yesterday.body.data.totals.sit, HOUR, '16:00 to 17:00');
  assert.equal(yesterday.body.data.totals.away, 0, 'no overnight absence is recorded');
});

test('sleeping and waking within the same working day just resumes', async (t) => {
  const { call, clock } = await startServer(t, on(7, '11:00'));
  await call('/api/toggle', 'POST', { posture: 'stand' });

  clock.ms = on(7, '12:00');
  await call('/api/toggle', 'POST', { posture: 'away', at: on(7, '12:00') });

  clock.ms = on(7, '13:00');
  const back = await call('/api/toggle', 'POST', { posture: 'stand', at: on(7, '13:00') });

  assert.equal(back.body.data.session.posture, 'stand');
  assert.equal(back.body.data.today.away, HOUR, 'the break is kept');
  assert.equal(back.body.data.today.stand, HOUR, '11:00 to 12:00');
});

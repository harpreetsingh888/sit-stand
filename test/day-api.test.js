import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';

import { createRequestHandler } from '../lib/api.js';
import { openDatabase } from '../lib/db.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const MONDAY = '2026-09-07';
const at = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(2026, 8, 7, h, m, 0, 0).getTime();
};
const NOON = at('12:00');

async function startServer(t, { now = NOON, seed = [] } = {}) {
  const clock = { ms: now };
  const store = openDatabase();
  for (const row of seed) store.unsafeInsertSession(row);

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

const A_DAY = [
  { posture: 'sit', started_at: at('09:00'), ended_at: at('10:30') },
  { posture: 'stand', started_at: at('10:30'), ended_at: at('11:00') },
  { posture: 'sit', started_at: at('11:00'), ended_at: null },
];

/* --------------------------------------------------------------- reading */

test('the day view lists the blocks that make up a day', async (t) => {
  const { call } = await startServer(t, { seed: A_DAY });
  const { status, body } = await call(`/api/day?day=${MONDAY}`);

  assert.equal(status, 200);
  assert.equal(body.data.day, MONDAY);
  assert.deepEqual(body.data.sessions.map((s) => s.posture), ['sit', 'stand', 'sit']);
  assert.deepEqual(body.data.sessions.map((s) => s.id), [1, 2, 3]);
});

test('each block reports how long it ran, with the open one measured to now', async (t) => {
  const { call } = await startServer(t, { seed: A_DAY });
  const { body } = await call(`/api/day?day=${MONDAY}`);
  const [first, , open] = body.data.sessions;

  assert.equal(first.ms, 90 * MINUTE);
  assert.equal(open.ms, 60 * MINUTE, 'from 11:00 to the 12:00 clock');
  assert.equal(open.ended_at, null);
});

test('the day view carries the work window and the totals', async (t) => {
  const { call } = await startServer(t, { seed: A_DAY });
  const { body } = await call(`/api/day?day=${MONDAY}`);

  assert.equal(body.data.isWorkDay, true);
  assert.equal(body.data.workWindow.start, at('09:00'));
  assert.deepEqual(body.data.totals, { sit: 150 * MINUTE, stand: 30 * MINUTE, away: 0 });
});

test('the day view defaults to today and rejects a malformed date', async (t) => {
  const { call } = await startServer(t, { seed: A_DAY });
  assert.equal((await call('/api/day')).body.data.day, MONDAY);

  for (const bad of ['7-9-2026', '2026-13-01', 'today', '2026-09-32']) {
    const { status, body } = await call(`/api/day?day=${bad}`);
    assert.equal(status, 400, `expected ${bad} to be rejected`);
    assert.match(body.error.message, /day/i);
  }
});

/* ----------------------------------------------------- implausible blocks */

test('an unbroken stretch past the threshold is flagged', async (t) => {
  const { call } = await startServer(t, {
    now: at('17:00'),
    seed: [{ posture: 'sit', started_at: at('09:00'), ended_at: at('16:00') }],
  });
  const { body } = await call(`/api/day?day=${MONDAY}`);

  assert.equal(body.data.sessions[0].implausible, true);
  assert.equal(body.data.implausibleCount, 1);
});

test('ordinary stretches are not flagged', async (t) => {
  const { call } = await startServer(t, { seed: A_DAY });
  const { body } = await call(`/api/day?day=${MONDAY}`);

  assert.ok(body.data.sessions.every((s) => s.implausible === false));
  assert.equal(body.data.implausibleCount, 0);
});

test('the threshold that decides it can be changed', async (t) => {
  const { call } = await startServer(t, { seed: A_DAY });
  await call('/api/settings', 'PUT', { implausibleAfterMinutes: 75 });

  const { body } = await call(`/api/day?day=${MONDAY}`);
  assert.deepEqual(
    body.data.sessions.map((s) => s.implausible),
    [true, false, false],
    'only the 90-minute block crosses a 75-minute threshold',
  );
});

/* ---------------------------------------------------------------- editing */

test('a block posture can be corrected through the API', async (t) => {
  const { call } = await startServer(t, { seed: A_DAY });
  const { status, body } = await call('/api/sessions/1', 'PATCH', { posture: 'away' });

  assert.equal(status, 200);
  assert.equal(body.data.sessions[0].posture, 'away', 'the refreshed day comes back');
  assert.equal(body.data.totals.away, 90 * MINUTE);
});

test('a boundary can be moved through the API', async (t) => {
  const { call } = await startServer(t, { seed: A_DAY });
  const { body } = await call('/api/sessions/2', 'PATCH', {
    started_at: at('10:45'),
    ended_at: at('11:00'),
  });

  const [first, second] = body.data.sessions;
  assert.equal(second.started_at, at('10:45'));
  assert.equal(first.ended_at, at('10:30'), 'the neighbour is untouched, so a gap opens');
});

test('an overlapping edit is refused with a reason', async (t) => {
  const { call } = await startServer(t, { seed: A_DAY });
  const { status, body } = await call('/api/sessions/2', 'PATCH', { started_at: at('09:30') });

  assert.equal(status, 409);
  assert.equal(body.ok, false);
  assert.match(body.error.message, /overlap/i);
});

test('editing a session that does not exist is a 404', async (t) => {
  const { call } = await startServer(t, { seed: A_DAY });
  assert.equal((await call('/api/sessions/999', 'PATCH', { posture: 'sit' })).status, 404);
});

test('a nonsense session id is a 404, not a crash', async (t) => {
  const { call } = await startServer(t, { seed: A_DAY });
  assert.equal((await call('/api/sessions/abc', 'PATCH', { posture: 'sit' })).status, 404);
});

test('a bad edit body is refused', async (t) => {
  const { call } = await startServer(t, { seed: A_DAY });
  const { status, body } = await call('/api/sessions/1', 'PATCH', { posture: 'floating' });
  assert.equal(status, 400);
  assert.match(body.error.message, /posture/i);
});

/* -------------------------------------------------------------- splitting */

test('a forgotten switch is put back by splitting', async (t) => {
  const { call } = await startServer(t, { seed: A_DAY });
  const { status, body } = await call('/api/sessions/1/split', 'POST', {
    at: at('09:45'),
    posture: 'stand',
  });

  assert.equal(status, 200);
  assert.deepEqual(
    body.data.sessions.map((s) => [s.posture, s.started_at]),
    [
      ['sit', at('09:00')],
      ['stand', at('09:45')],
      ['stand', at('10:30')],
      ['sit', at('11:00')],
    ],
  );
});

test('a split at the edge of a block is refused', async (t) => {
  const { call } = await startServer(t, { seed: A_DAY });
  const { status } = await call('/api/sessions/1/split', 'POST', {
    at: at('09:00'),
    posture: 'stand',
  });
  assert.equal(status, 400);
});

/* --------------------------------------------------- deleting and adding */

test('a junk block can be deleted', async (t) => {
  const { call } = await startServer(t, { seed: A_DAY });
  const { status, body } = await call('/api/sessions/2', 'DELETE');

  assert.equal(status, 200);
  assert.deepEqual(body.data.sessions.map((s) => s.id), [1, 3]);
});

test('a missing block can be added into a gap', async (t) => {
  const { call } = await startServer(t, { seed: A_DAY });
  await call('/api/sessions/2', 'DELETE');
  const { status, body } = await call('/api/sessions', 'POST', {
    posture: 'away',
    started_at: at('10:30'),
    ended_at: at('11:00'),
  });

  assert.equal(status, 200);
  assert.deepEqual(body.data.sessions.map((s) => s.posture), ['sit', 'away', 'sit']);
});

test('adding a block on top of an existing one is refused', async (t) => {
  const { call } = await startServer(t, { seed: A_DAY });
  const { status } = await call('/api/sessions', 'POST', {
    posture: 'away',
    started_at: at('09:30'),
    ended_at: at('10:45'),
  });
  assert.equal(status, 409);
});

test('the wrong method on a session route is refused', async (t) => {
  const { call } = await startServer(t, { seed: A_DAY });
  assert.equal((await call('/api/sessions/1', 'PUT', {})).status, 405);
});

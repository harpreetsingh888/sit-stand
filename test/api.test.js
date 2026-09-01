import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';

import { createRequestHandler } from '../lib/api.js';
import { openDatabase } from '../lib/db.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

// Monday 2026-09-07, 10:00 local: inside the default 09:00-18:00 window.
const MONDAY_10AM = new Date(2026, 8, 7, 10, 0, 0, 0).getTime();

async function startServer(t, startTime = MONDAY_10AM) {
  const clock = { ms: startTime };
  const store = openDatabase();
  const server = http.createServer(
    createRequestHandler({ store, now: () => clock.ms }),
  );
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.close();
    await once(server, 'close');
    store.close();
  });

  const call = async (path, options) => {
    const response = await fetch(base + path, options);
    const text = await response.text();
    const isJson = (response.headers.get('content-type') ?? '').includes('json');
    return { status: response.status, body: isJson ? JSON.parse(text) : text, response };
  };
  const json = (path, method, payload) =>
    call(path, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });

  return { clock, store, base, call, json };
}

test('state on an empty database reports nothing running', async (t) => {
  const { call } = await startServer(t);
  const { status, body } = await call('/api/state');

  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.data.session, null);
  assert.deepEqual(
    { sit: body.data.today.sit, stand: body.data.today.stand },
    { sit: 0, stand: 0 },
  );
  assert.equal(body.data.settings.workStart, '09:00');
  assert.equal(body.data.withinWorkHours, true);
});

test('the first toggle starts a sitting session', async (t) => {
  const { call } = await startServer(t);
  const { status, body } = await call('/api/toggle', { method: 'POST' });

  assert.equal(status, 200);
  assert.equal(body.data.session.posture, 'sit');
  assert.equal(body.data.session.elapsedMs, 0);
});

test('a second toggle switches to standing', async (t) => {
  const { call, clock } = await startServer(t);
  await call('/api/toggle', { method: 'POST' });
  clock.ms += 30 * MINUTE;
  const { body } = await call('/api/toggle', { method: 'POST' });

  assert.equal(body.data.session.posture, 'stand');
  assert.equal(body.data.today.sit, 30 * MINUTE);
  assert.equal(body.data.today.stand, 0);
});

test('a toggle may name the posture explicitly and is then idempotent', async (t) => {
  const { json, clock } = await startServer(t);
  const first = await json('/api/toggle', 'POST', { posture: 'stand' });
  assert.equal(first.body.data.session.posture, 'stand');

  clock.ms += 10 * MINUTE;
  const again = await json('/api/toggle', 'POST', { posture: 'stand' });
  assert.equal(again.body.data.session.posture, 'stand');
  assert.equal(again.body.data.session.elapsedMs, 10 * MINUTE, 'the original session continues');
});

test('an unknown posture is rejected', async (t) => {
  const { json } = await startServer(t);
  const { status, body } = await json('/api/toggle', 'POST', { posture: 'lying' });

  assert.equal(status, 400);
  assert.equal(body.ok, false);
  assert.match(body.error.message, /posture/i);
});

test('elapsed time and the day total advance with the clock', async (t) => {
  const { call, clock } = await startServer(t);
  await call('/api/toggle', { method: 'POST' });
  clock.ms += 45 * MINUTE;

  const { body } = await call('/api/state');
  assert.equal(body.data.session.elapsedMs, 45 * MINUTE);
  assert.equal(body.data.today.sit, 45 * MINUTE);
});

test('stopping ends the session and keeps the time already accrued', async (t) => {
  const { call, clock } = await startServer(t);
  await call('/api/toggle', { method: 'POST' });
  clock.ms += 20 * MINUTE;

  const { body } = await call('/api/stop', { method: 'POST' });
  assert.equal(body.data.session, null);
  assert.equal(body.data.today.sit, 20 * MINUTE);

  clock.ms += 60 * MINUTE;
  const later = await call('/api/state');
  assert.equal(later.body.data.today.sit, 20 * MINUTE, 'a stopped session stops accruing');
});

test('goal progress is reported against the standing goal', async (t) => {
  const { json, call, clock } = await startServer(t);
  await json('/api/toggle', 'POST', { posture: 'stand' });
  clock.ms += 60 * MINUTE;

  const { body } = await call('/api/state');
  assert.equal(body.data.goal.goalMs, 120 * MINUTE);
  assert.equal(body.data.goal.ratio, 0.5);
  assert.equal(body.data.goal.met, false);
});

test('time outside working hours is not counted', async (t) => {
  // 20:00 on the Monday, well after the 18:00 default finish.
  const evening = new Date(2026, 8, 7, 20, 0, 0, 0).getTime();
  const { call, clock } = await startServer(t, evening);
  await call('/api/toggle', { method: 'POST' });
  clock.ms += 60 * MINUTE;

  const { body } = await call('/api/state');
  assert.equal(body.data.withinWorkHours, false);
  assert.equal(body.data.today.sit, 0);
  assert.equal(body.data.session.elapsedMs, 60 * MINUTE, 'the session itself is still timed');
});

test('history returns the requested number of days, oldest first', async (t) => {
  const { call } = await startServer(t);
  const { status, body } = await call('/api/history?days=3');

  assert.equal(status, 200);
  assert.equal(body.data.days.length, 3);
  assert.deepEqual(
    body.data.days.map((d) => d.day),
    ['2026-09-05', '2026-09-06', '2026-09-07'],
  );
  assert.equal(body.data.days.at(-1).day, '2026-09-07', 'today is last');
});

test('history defaults to a fortnight and marks non-working days', async (t) => {
  const { call } = await startServer(t);
  const { body } = await call('/api/history');

  assert.equal(body.data.days.length, 14);
  const saturday = body.data.days.find((d) => d.day === '2026-09-05');
  const monday = body.data.days.find((d) => d.day === '2026-09-07');
  assert.equal(saturday.isWorkDay, false, 'the 5th is a Saturday');
  assert.equal(monday.isWorkDay, true, 'the 7th is a Monday');
});

test('history rejects a nonsensical day count', async (t) => {
  const { call } = await startServer(t);
  for (const query of ['days=0', 'days=-1', 'days=abc', 'days=1000', 'days=2.5']) {
    const { status, body } = await call(`/api/history?${query}`);
    assert.equal(status, 400, `expected ${query} to be rejected`);
    assert.equal(body.ok, false);
    assert.match(body.error.message, /days/i);
  }
});

test('settings can be read and updated', async (t) => {
  const { call, json } = await startServer(t);
  const updated = await json('/api/settings', 'PUT', { standGoalMinutes: 90, workDays: [1, 2, 3] });

  assert.equal(updated.status, 200);
  assert.equal(updated.body.data.settings.standGoalMinutes, 90);
  assert.deepEqual(updated.body.data.settings.workDays, [1, 2, 3]);

  const read = await call('/api/settings');
  assert.equal(read.body.data.settings.standGoalMinutes, 90);
});

test('invalid settings are rejected field by field and nothing is saved', async (t) => {
  const { call, json } = await startServer(t);
  const { status, body } = await json('/api/settings', 'PUT', {
    workEnd: '08:00',
    sitNudgeMinutes: 0,
  });

  assert.equal(status, 400);
  assert.equal(body.ok, false);
  assert.deepEqual(
    body.error.fields.map((f) => f.field).sort(),
    ['sitNudgeMinutes', 'workEnd'],
  );

  const read = await call('/api/settings');
  assert.equal(read.body.data.settings.workEnd, '18:00', 'the rejected update was not applied');
});

test('malformed JSON is rejected', async (t) => {
  const { call } = await startServer(t);
  const { status, body } = await call('/api/settings', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: '{nope',
  });

  assert.equal(status, 400);
  assert.match(body.error.message, /json/i);
});

test('changing the work hours re-derives past days', async (t) => {
  const { call, json, clock } = await startServer(t);
  await call('/api/toggle', { method: 'POST' });
  clock.ms += 2 * HOUR; // sat from 10:00 to 12:00

  const before = await call('/api/state');
  assert.equal(before.body.data.today.sit, 2 * HOUR);

  await json('/api/settings', 'PUT', { workStart: '11:00' });
  const after = await call('/api/state');
  assert.equal(after.body.data.today.sit, 1 * HOUR, 'the earlier hour now falls outside work');
});

test('the CSV export contains a header and every raw session', async (t) => {
  const { call, clock } = await startServer(t);
  await call('/api/toggle', { method: 'POST' });
  clock.ms += 15 * MINUTE;
  await call('/api/toggle', { method: 'POST' });

  const result = await call('/api/export.csv');
  assert.equal(result.status, 200);
  assert.match(result.response.headers.get('content-type'), /text\/csv/);

  const lines = result.body.trim().split('\n');
  assert.equal(lines[0], 'id,posture,started_at,ended_at,started_iso,ended_iso');
  assert.equal(lines.length, 3, 'header plus two sessions');
  assert.match(lines[1], /^1,sit,/);
  assert.match(lines[2], /^2,stand,/);
});

test('an unknown API route returns a 404 envelope', async (t) => {
  const { call } = await startServer(t);
  const { status, body } = await call('/api/nope');

  assert.equal(status, 404);
  assert.equal(body.ok, false);
  assert.ok(body.error.message);
});

test('the wrong method on a known route is refused', async (t) => {
  const { call } = await startServer(t);
  const { status } = await call('/api/toggle');
  assert.equal(status, 405);
});

test('the page is served at the root', async (t) => {
  const { call } = await startServer(t);
  const { status, body, response } = await call('/');

  assert.equal(status, 200);
  assert.match(response.headers.get('content-type'), /text\/html/);
  assert.match(body, /<title>/i);
});

test('paths outside the public directory are refused', async (t) => {
  const { base } = await startServer(t);
  for (const path of ['/../package.json', '/..%2fpackage.json', '/%2e%2e/lib/db.js']) {
    const response = await fetch(base + path, { redirect: 'manual' });
    assert.ok(response.status >= 400, `expected ${path} to be refused, got ${response.status}`);
  }
});

/* ------------------------------------------------------------ away from desk */

test('going away is recorded and timed', async (t) => {
  const { json, call, clock } = await startServer(t);
  await json('/api/toggle', 'POST', { posture: 'sit' });
  clock.ms += 30 * MINUTE;

  const gone = await json('/api/toggle', 'POST', { posture: 'away' });
  assert.equal(gone.body.data.session.posture, 'away');
  assert.equal(gone.body.data.today.sit, 30 * MINUTE);

  clock.ms += 45 * MINUTE;
  const { body } = await call('/api/state');
  assert.equal(body.data.today.away, 45 * MINUTE);
  assert.equal(body.data.today.sit, 30 * MINUTE, 'sitting stopped accruing');
  assert.equal(body.data.session.elapsedMs, 45 * MINUTE);
});

test('away does not count towards the standing goal', async (t) => {
  const { json, call, clock } = await startServer(t);
  await json('/api/toggle', 'POST', { posture: 'away' });
  clock.ms += 2 * HOUR;

  const { body } = await call('/api/state');
  assert.equal(body.data.goal.standMs, 0);
  assert.equal(body.data.goal.ratio, 0);
  assert.equal(body.data.today.away, 2 * HOUR);
});

test('coming back from away resumes a posture', async (t) => {
  const { json, clock } = await startServer(t);
  await json('/api/toggle', 'POST', { posture: 'away' });
  clock.ms += 20 * MINUTE;

  const back = await json('/api/toggle', 'POST', { posture: 'stand' });
  assert.equal(back.body.data.session.posture, 'stand');
  assert.equal(back.body.data.session.elapsedMs, 0);
  assert.equal(back.body.data.today.away, 20 * MINUTE);
});

test('a toggle with no posture never chooses away on its own', async (t) => {
  const { json, call, clock } = await startServer(t);
  await json('/api/toggle', 'POST', { posture: 'away' });
  clock.ms += 10 * MINUTE;

  const { body } = await call('/api/toggle', { method: 'POST' });
  assert.equal(body.data.session.posture, 'sit', 'a bare toggle brings you back to your desk');
});

test('away time outside working hours is not counted', async (t) => {
  const evening = new Date(2026, 8, 7, 20, 0, 0, 0).getTime();
  const { json, call, clock } = await startServer(t, evening);
  await json('/api/toggle', 'POST', { posture: 'away' });
  clock.ms += 90 * MINUTE;

  const { body } = await call('/api/state');
  assert.equal(body.data.today.away, 0);
});

test('history reports away for every day', async (t) => {
  const { json, call, clock } = await startServer(t);
  await json('/api/toggle', 'POST', { posture: 'away' });
  clock.ms += 25 * MINUTE;

  const { body } = await call('/api/history?days=3');
  assert.ok(body.data.days.every((day) => typeof day.away === 'number'));
  assert.equal(body.data.days.at(-1).away, 25 * MINUTE);
});

test('the export includes away sessions', async (t) => {
  const { json, call, clock } = await startServer(t);
  await json('/api/toggle', 'POST', { posture: 'away' });
  clock.ms += 5 * MINUTE;
  await json('/api/toggle', 'POST', { posture: 'sit' });

  const { body } = await call('/api/export.csv');
  assert.match(body, /^\d+,away,/m);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';

import { createRequestHandler } from '../lib/api.js';
import { openDatabase } from '../lib/db.js';

const HOUR = 3_600_000;
const on = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(2026, 8, 7, h, m, 0, 0).getTime();
};

async function startServer(t, now = on('13:00')) {
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

/** A morning the desktop has already recorded and closed off. */
async function recordedMorning(call, clock) {
  clock.ms = on('09:00');
  await call('/api/toggle', 'POST', { posture: 'sit' });
  clock.ms = on('11:00');
  await call('/api/toggle', 'POST', { posture: 'stand' });
  clock.ms = on('13:00');
}

test('a queued action that fits is applied on sync', async (t) => {
  const { call, clock } = await startServer(t);
  await recordedMorning(call, clock);

  const { status, body } = await call('/api/sync', 'POST', {
    actions: [{ posture: 'away', at: on('12:00') }],
  });

  assert.equal(status, 200);
  assert.equal(body.data.applied, 1);
  assert.deepEqual(body.data.conflicts, []);
  assert.equal(body.data.state.session.posture, 'away');
});

test('a queued action contradicting a closed block becomes a conflict', async (t) => {
  const { call, clock } = await startServer(t);
  await recordedMorning(call, clock);

  // The phone insists it was away at 10:00; the desktop recorded sitting.
  const { body } = await call('/api/sync', 'POST', {
    actions: [{ posture: 'away', at: on('10:00') }],
  });

  assert.equal(body.data.applied, 0);
  assert.equal(body.data.conflicts.length, 1);

  const conflict = body.data.conflicts[0];
  assert.equal(conflict.queued_posture, 'away');
  assert.equal(conflict.existing_posture, 'sit');
  assert.equal(conflict.existing_started_at, on('09:00'));
});

test('the desktop record stands until the conflict is settled', async (t) => {
  const { call, clock } = await startServer(t);
  await recordedMorning(call, clock);
  await call('/api/sync', 'POST', { actions: [{ posture: 'away', at: on('10:00') }] });

  const { body } = await call('/api/day');
  assert.deepEqual(body.data.sessions.map((s) => s.posture), ['sit', 'stand']);
  assert.equal(body.data.totals.away, 0, 'nothing was applied behind your back');
});

test('open conflicts are surfaced with the state, so either device can ask', async (t) => {
  const { call, clock } = await startServer(t);
  await recordedMorning(call, clock);
  await call('/api/sync', 'POST', { actions: [{ posture: 'away', at: on('10:00') }] });

  const { body } = await call('/api/state');
  assert.equal(body.data.conflicts.length, 1);
  assert.equal(body.data.conflicts[0].queued_posture, 'away');
});

test('keeping the desktop version settles it and changes nothing', async (t) => {
  const { call, clock } = await startServer(t);
  await recordedMorning(call, clock);
  const sync = await call('/api/sync', 'POST', { actions: [{ posture: 'away', at: on('10:00') }] });
  const id = sync.body.data.conflicts[0].id;

  const { status, body } = await call(`/api/conflicts/${id}/resolve`, 'POST', { choice: 'existing' });
  assert.equal(status, 200);
  assert.deepEqual(body.data.conflicts, [], 'no longer asked about');

  const day = await call('/api/day');
  assert.deepEqual(day.body.data.sessions.map((s) => s.posture), ['sit', 'stand']);
});

test('choosing the phone version splits the recorded block at that moment', async (t) => {
  const { call, clock } = await startServer(t);
  await recordedMorning(call, clock);
  const sync = await call('/api/sync', 'POST', { actions: [{ posture: 'away', at: on('10:00') }] });
  const id = sync.body.data.conflicts[0].id;

  const { body } = await call(`/api/conflicts/${id}/resolve`, 'POST', { choice: 'queued' });
  assert.deepEqual(body.data.conflicts, []);

  const day = await call('/api/day');
  assert.deepEqual(
    day.body.data.sessions.map((s) => [s.posture, s.started_at]),
    [
      ['sit', on('09:00')],
      ['away', on('10:00')],
      ['stand', on('11:00')],
    ],
  );
});

test('a conflict cannot be settled twice or with nonsense', async (t) => {
  const { call, clock } = await startServer(t);
  await recordedMorning(call, clock);
  const sync = await call('/api/sync', 'POST', { actions: [{ posture: 'away', at: on('10:00') }] });
  const id = sync.body.data.conflicts[0].id;

  assert.equal((await call(`/api/conflicts/${id}/resolve`, 'POST', { choice: 'sideways' })).status, 400);
  await call(`/api/conflicts/${id}/resolve`, 'POST', { choice: 'existing' });
  assert.equal((await call(`/api/conflicts/${id}/resolve`, 'POST', { choice: 'existing' })).status, 409);
  assert.equal((await call('/api/conflicts/999/resolve', 'POST', { choice: 'existing' })).status, 404);
});

test('a malformed queue is refused rather than half applied', async (t) => {
  const { call } = await startServer(t);
  assert.equal((await call('/api/sync', 'POST', { actions: 'lots' })).status, 400);
  assert.equal((await call('/api/sync', 'POST', {})).status, 400);

  const { body } = await call('/api/sync', 'POST', {
    actions: [{ posture: 'hovering', at: on('10:00') }],
  });
  assert.equal(body.data.rejected, 1);
  assert.equal(body.data.applied, 0);
});

test('replaying the same queue twice does not double up', async (t) => {
  const { call, clock } = await startServer(t);
  await recordedMorning(call, clock);
  const queue = { actions: [{ posture: 'away', at: on('12:00') }] };

  await call('/api/sync', 'POST', queue);
  const second = await call('/api/sync', 'POST', queue);

  assert.equal(second.body.data.applied, 0, 'the second pass agrees with what is there');
  assert.equal(second.body.data.conflicts.length, 0);
});

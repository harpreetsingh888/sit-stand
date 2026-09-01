import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';

import { createRequestHandler } from '../lib/api.js';
import { createBroadcaster } from '../lib/events.js';
import { openDatabase } from '../lib/db.js';

async function startServer(t) {
  const store = openDatabase();
  const broadcaster = createBroadcaster();
  const server = http.createServer(createRequestHandler({ store, broadcaster }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;

  t.after(async () => {
    broadcaster.closeAll();
    server.close();
    await once(server, 'close');
    store.close();
  });

  const post = (path, payload) =>
    fetch(base + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload ?? {}),
    });

  return { base, store, broadcaster, post };
}

/** Open the stream and hand back a reader that yields one event at a time. */
async function openStream(base) {
  const controller = new AbortController();
  const response = await fetch(`${base}/api/events`, { signal: controller.signal });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  async function next(timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const boundary = buffer.indexOf('\n\n');
      if (boundary !== -1) {
        const raw = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        // Skip heartbeats, which are comment lines.
        if (!raw.startsWith(':')) return parseEvent(raw);
        continue;
      }
      if (Date.now() > deadline) throw new Error('no event arrived in time');
      const { value, done } = await reader.read();
      if (done) throw new Error('the stream closed');
      buffer += decoder.decode(value, { stream: true });
    }
  }

  return { response, next, close: () => controller.abort() };
}

function parseEvent(raw) {
  const event = { event: 'message', data: '' };
  for (const line of raw.split('\n')) {
    if (line.startsWith('event:')) event.event = line.slice(6).trim();
    if (line.startsWith('data:')) event.data += line.slice(5).trim();
  }
  return { ...event, data: event.data ? JSON.parse(event.data) : null };
}

test('the stream announces itself as server-sent events', async (t) => {
  const { base } = await startServer(t);
  const stream = await openStream(base);

  assert.match(stream.response.headers.get('content-type'), /text\/event-stream/);
  assert.equal(stream.response.headers.get('cache-control'), 'no-store');
  stream.close();
});

test('a client is told the current state as soon as it connects', async (t) => {
  const { base, post } = await startServer(t);
  await post('/api/toggle', { posture: 'stand' });

  const stream = await openStream(base);
  const first = await stream.next();

  assert.equal(first.event, 'state');
  assert.equal(first.data.session.posture, 'stand');
  stream.close();
});

test('a switch on one device reaches a listening one', async (t) => {
  const { base, post } = await startServer(t);
  const stream = await openStream(base);
  await stream.next(); // the state it opened with

  await post('/api/toggle', { posture: 'away' });
  const update = await stream.next();

  assert.equal(update.event, 'state');
  assert.equal(update.data.session.posture, 'away');
  stream.close();
});

test('stopping is announced too', async (t) => {
  const { base, post } = await startServer(t);
  await post('/api/toggle', { posture: 'sit' });

  const stream = await openStream(base);
  await stream.next();

  await post('/api/stop');
  const update = await stream.next();
  assert.equal(update.data.session, null);
  stream.close();
});

test('correcting the record is announced, so a timeline elsewhere redraws', async (t) => {
  const { base, post, store } = await startServer(t);
  await post('/api/toggle', { posture: 'sit' });

  const stream = await openStream(base);
  await stream.next();

  const open = store.currentSession();
  await fetch(`${base}/api/sessions/${open.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ posture: 'stand' }),
  });

  const update = await stream.next();
  assert.equal(update.data.session.posture, 'stand');
  stream.close();
});

test('changing settings is announced', async (t) => {
  const { base } = await startServer(t);
  const stream = await openStream(base);
  await stream.next();

  await fetch(`${base}/api/settings`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ standGoalMinutes: 45 }),
  });

  const update = await stream.next();
  assert.equal(update.data.settings.standGoalMinutes, 45);
  stream.close();
});

test('reading does not disturb listeners', async (t) => {
  const { base } = await startServer(t);
  const stream = await openStream(base);
  await stream.next();

  await fetch(`${base}/api/state`);
  await fetch(`${base}/api/history?days=3`);

  await assert.rejects(() => stream.next(400), /no event arrived/);
  stream.close();
});

test('several devices are all told', async (t) => {
  const { base, post, broadcaster } = await startServer(t);
  const desktop = await openStream(base);
  const phone = await openStream(base);
  await desktop.next();
  await phone.next();

  assert.equal(broadcaster.count(), 2);

  await post('/api/toggle', { posture: 'stand' });
  assert.equal((await desktop.next()).data.session.posture, 'stand');
  assert.equal((await phone.next()).data.session.posture, 'stand');

  desktop.close();
  phone.close();
});

test('a departing listener is forgotten', async (t) => {
  const { base, broadcaster } = await startServer(t);
  const stream = await openStream(base);
  await stream.next();
  assert.equal(broadcaster.count(), 1);

  stream.close();
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(broadcaster.count(), 0, 'the connection was let go');
});

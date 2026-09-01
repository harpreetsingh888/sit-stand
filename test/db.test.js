import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DatabaseSync } from 'node:sqlite';

import { openDatabase } from '../lib/db.js';
import { DEFAULT_SETTINGS } from '../lib/settings.js';

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 8, 7, 9, 0, 0);

test('a fresh database tracks nothing and reports default settings', () => {
  const store = openDatabase();
  assert.equal(store.currentSession(), null);
  assert.deepEqual(store.getSettings(), DEFAULT_SETTINGS);
  store.close();
});

test('setPosture opens a session', () => {
  const store = openDatabase();
  const session = store.setPosture('stand', T0);

  assert.equal(session.posture, 'stand');
  assert.equal(session.started_at, T0);
  assert.equal(session.ended_at, null);
  assert.deepEqual(store.currentSession(), session);
  store.close();
});

test('switching posture closes the old session at the moment the new one starts', () => {
  const store = openDatabase();
  const first = store.setPosture('sit', T0);
  const second = store.setPosture('stand', T0 + HOUR);

  const [closed, open] = store.allSessions();
  assert.equal(closed.id, first.id);
  assert.equal(closed.ended_at, T0 + HOUR, 'no gap between sessions');
  assert.equal(open.id, second.id);
  assert.equal(open.ended_at, null);
  store.close();
});

test('setting the posture that is already current changes nothing', () => {
  const store = openDatabase();
  const first = store.setPosture('sit', T0);
  const again = store.setPosture('sit', T0 + HOUR);

  assert.deepEqual(again, first);
  assert.equal(store.allSessions().length, 1);
  store.close();
});

test('setPosture rejects a posture that is not sit or stand', () => {
  const store = openDatabase();
  assert.throws(() => store.setPosture('lying', T0), /posture/i);
  assert.equal(store.allSessions().length, 0);
  store.close();
});

test('a backwards clock cannot produce a negative session', () => {
  const store = openDatabase();
  store.setPosture('sit', T0);
  store.setPosture('stand', T0 - HOUR);

  const [closed] = store.allSessions();
  assert.equal(closed.ended_at, T0, 'clamped to its own start rather than going negative');
  store.close();
});

test('stopTracking closes the open session and leaves nothing running', () => {
  const store = openDatabase();
  store.setPosture('sit', T0);
  store.stopTracking(T0 + HOUR);

  assert.equal(store.currentSession(), null);
  assert.equal(store.allSessions()[0].ended_at, T0 + HOUR);
  store.close();
});

test('stopTracking with nothing running is harmless', () => {
  const store = openDatabase();
  store.stopTracking(T0);
  assert.equal(store.currentSession(), null);
  assert.equal(store.allSessions().length, 0);
  store.close();
});

test('the database itself refuses a second open session', () => {
  const store = openDatabase();
  store.setPosture('sit', T0);
  assert.throws(
    () => store.unsafeInsertSession({ posture: 'stand', started_at: T0, ended_at: null }),
    /UNIQUE|constraint/i,
  );
  store.close();
});

test('the database itself refuses a session that ends before it starts', () => {
  const store = openDatabase();
  assert.throws(
    () => store.unsafeInsertSession({ posture: 'sit', started_at: T0, ended_at: T0 - HOUR }),
    /constraint|CHECK/i,
  );
  store.close();
});

test('sessionsBetween returns everything overlapping the range', () => {
  const store = openDatabase();
  store.unsafeInsertSession({ posture: 'sit', started_at: T0 - 5 * HOUR, ended_at: T0 - 4 * HOUR });
  store.unsafeInsertSession({ posture: 'stand', started_at: T0 - HOUR, ended_at: T0 + HOUR });
  store.unsafeInsertSession({ posture: 'sit', started_at: T0 + 6 * HOUR, ended_at: null });

  const overlapping = store.sessionsBetween(T0, T0 + 2 * HOUR);
  assert.deepEqual(overlapping.map((s) => s.posture), ['stand']);

  const wide = store.sessionsBetween(T0 - 10 * HOUR, T0 + 10 * HOUR);
  assert.equal(wide.length, 3);
  store.close();
});

test('sessionsBetween includes a still-open session that began long ago', () => {
  const store = openDatabase();
  store.setPosture('sit', T0 - 100 * HOUR);
  assert.equal(store.sessionsBetween(T0, T0 + HOUR).length, 1);
  store.close();
});

test('settings round-trip through the database', () => {
  const store = openDatabase();
  const updated = { ...DEFAULT_SETTINGS, workStart: '08:15', workDays: [1, 3], standGoalMinutes: 60 };
  store.saveSettings(updated);

  assert.deepEqual(store.getSettings(), updated);
  store.close();
});

test('data survives closing and reopening the file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sit-stand-'));
  const file = path.join(dir, 'test.db');
  try {
    const first = openDatabase(file);
    first.setPosture('stand', T0);
    first.saveSettings({ ...DEFAULT_SETTINGS, standGoalMinutes: 45 });
    first.close();

    const second = openDatabase(file);
    assert.equal(second.currentSession().posture, 'stand');
    assert.equal(second.getSettings().standGoalMinutes, 45);
    second.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------- away posture */

test('away is a storable posture', () => {
  const store = openDatabase();
  const session = store.setPosture('away', T0);
  assert.equal(session.posture, 'away');
  assert.equal(store.currentSession().posture, 'away');
  store.close();
});

test('going away closes the session that was running', () => {
  const store = openDatabase();
  store.setPosture('sit', T0);
  store.setPosture('away', T0 + HOUR);

  const [sat, gone] = store.allSessions();
  assert.equal(sat.ended_at, T0 + HOUR);
  assert.equal(gone.posture, 'away');
  assert.equal(gone.ended_at, null);
  store.close();
});

test('coming back from away starts a fresh posture session', () => {
  const store = openDatabase();
  store.setPosture('away', T0);
  const back = store.setPosture('stand', T0 + 30 * 60_000);

  assert.equal(back.posture, 'stand');
  assert.equal(back.started_at, T0 + 30 * 60_000);
  assert.equal(store.allSessions().length, 2);
  store.close();
});

/* ----------------------------------------------------------------- migration */

/** Build a database in the original sit/stand-only shape, as v1.0 wrote it. */
function writeLegacyDatabase(file, rows) {
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE sessions (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      posture    TEXT    NOT NULL CHECK (posture IN ('sit', 'stand')),
      started_at INTEGER NOT NULL,
      ended_at   INTEGER,
      is_open    INTEGER GENERATED ALWAYS AS (CASE WHEN ended_at IS NULL THEN 1 END) VIRTUAL,
      CHECK (ended_at IS NULL OR ended_at >= started_at)
    );
    CREATE UNIQUE INDEX sessions_single_open ON sessions (is_open);
    CREATE INDEX sessions_started_at ON sessions (started_at);
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  const insert = db.prepare('INSERT INTO sessions (posture, started_at, ended_at) VALUES (?, ?, ?)');
  for (const row of rows) insert.run(row.posture, row.started_at, row.ended_at);
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('standGoalMinutes', '75');
  db.close();
}

function withTempFile(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sit-stand-migrate-'));
  try {
    return run(path.join(dir, 'legacy.db'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('an old database is migrated in place, keeping every session', () => {
  withTempFile((file) => {
    writeLegacyDatabase(file, [
      { posture: 'sit', started_at: T0, ended_at: T0 + HOUR },
      { posture: 'stand', started_at: T0 + HOUR, ended_at: T0 + 2 * HOUR },
      { posture: 'sit', started_at: T0 + 2 * HOUR, ended_at: null },
    ]);

    const store = openDatabase(file);
    const sessions = store.allSessions();

    assert.deepEqual(sessions.map((s) => s.posture), ['sit', 'stand', 'sit']);
    assert.deepEqual(sessions.map((s) => s.id), [1, 2, 3], 'identifiers are preserved');
    assert.equal(sessions[0].ended_at, T0 + HOUR);
    assert.equal(store.currentSession().id, 3, 'the open session is still open');
    assert.equal(store.getSettings().standGoalMinutes, 75, 'settings survive');
    store.close();
  });
});

test('a migrated database accepts away and keeps its constraints', () => {
  withTempFile((file) => {
    writeLegacyDatabase(file, [{ posture: 'sit', started_at: T0, ended_at: T0 + HOUR }]);

    const store = openDatabase(file);
    assert.equal(store.setPosture('away', T0 + HOUR).posture, 'away');

    assert.throws(
      () => store.unsafeInsertSession({ posture: 'stand', started_at: T0, ended_at: null }),
      /UNIQUE|constraint/i,
      'one open session at a time still holds after the rebuild',
    );
    assert.throws(
      () => store.unsafeInsertSession({ posture: 'sit', started_at: T0, ended_at: T0 - HOUR }),
      /constraint|CHECK/i,
      'a session still cannot end before it starts',
    );
    store.close();
  });
});

test('migrating is done once and reopening is a no-op', () => {
  withTempFile((file) => {
    writeLegacyDatabase(file, [{ posture: 'sit', started_at: T0, ended_at: T0 + HOUR }]);

    const first = openDatabase(file);
    const version = first.schemaVersion();
    first.close();

    const second = openDatabase(file);
    assert.equal(second.schemaVersion(), version);
    assert.ok(version >= 1);
    assert.equal(second.allSessions().length, 1);
    second.close();
  });
});

test('a database from a newer version is refused rather than damaged', () => {
  withTempFile((file) => {
    const db = new DatabaseSync(file);
    db.exec('PRAGMA user_version = 999');
    db.close();

    assert.throws(() => openDatabase(file), /newer/i);
  });
});

test('closing leaves the database file complete on its own', () => {
  // Write-ahead logging keeps recent writes in a sidecar file. If closing did
  // not fold them back in, copying just the .db file - the obvious way to take
  // a backup - would silently produce an empty database.
  withTempFile((file) => {
    const store = openDatabase(file);
    store.setPosture('stand', T0);
    store.setPosture('away', T0 + HOUR);
    store.close();

    const copy = `${file}.backup`;
    fs.copyFileSync(file, copy);

    const restored = openDatabase(copy);
    assert.deepEqual(restored.allSessions().map((s) => s.posture), ['stand', 'away']);
    restored.close();
  });
});

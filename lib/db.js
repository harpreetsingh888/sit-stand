/**
 * Storage. One table of posture sessions, one table of settings.
 *
 * Two invariants are enforced by the schema rather than by careful calling
 * code: at most one session may be open at a time, and a session may not end
 * before it starts. Toggling happens inside a transaction, so an interrupted
 * write cannot leave two open sessions or none.
 */

import { DatabaseSync } from 'node:sqlite';

import { POSTURES } from './postures.js';
import { parseSettings, serializeSettings } from './settings.js';

export { POSTURES };

/** Bumped whenever the schema changes. Stored in the file's `user_version`. */
export const SCHEMA_VERSION = 2;

const COLUMNS = 'id, posture, started_at, ended_at';

const POSTURE_LIST = POSTURES.map((posture) => `'${posture}'`).join(', ');

/**
 * A posture constraint has to be written into the table definition, so widening
 * the set of postures means rebuilding the table. The name is a parameter so a
 * migration can build the replacement alongside the original.
 */
const sessionsTable = (name) => `
  CREATE TABLE ${name} (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    posture    TEXT    NOT NULL CHECK (posture IN (${POSTURE_LIST})),
    started_at INTEGER NOT NULL,
    ended_at   INTEGER,
    -- NULLs are distinct in a SQLite unique index, so this column is 1 for the
    -- single open session and NULL for every closed one. The unique index below
    -- therefore permits many closed sessions but only one open session.
    is_open    INTEGER GENERATED ALWAYS AS (CASE WHEN ended_at IS NULL THEN 1 END) VIRTUAL,
    CHECK (ended_at IS NULL OR ended_at >= started_at)
  );
`;

const SESSION_INDEXES = `
  CREATE UNIQUE INDEX IF NOT EXISTS sessions_single_open ON sessions (is_open);
  CREATE INDEX IF NOT EXISTS sessions_started_at ON sessions (started_at);
`;

/**
 * Disagreements between a phone's queued action and what is already recorded.
 * They are kept rather than resolved automatically so either device can put
 * the question to the person and act on the answer.
 */
const CONFLICTS_TABLE = `
  CREATE TABLE IF NOT EXISTS conflicts (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    queued_posture      TEXT    NOT NULL,
    queued_at           INTEGER NOT NULL,
    existing_session_id INTEGER,
    existing_posture    TEXT,
    existing_started_at INTEGER,
    existing_ended_at   INTEGER,
    noticed_at          INTEGER NOT NULL,
    resolved_at         INTEGER,
    resolution          TEXT
  );

  CREATE INDEX IF NOT EXISTS conflicts_unresolved ON conflicts (resolved_at);
`;

const SETTINGS_TABLE = `
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`;

const tableExists = (db, name) =>
  db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;

const schemaVersion = (db) => db.prepare('PRAGMA user_version').get().user_version;

/**
 * Replace the sessions table with one built from the current posture list,
 * carrying every existing row across. Dropping the old table takes its indexes
 * with it, so they are recreated afterwards.
 */
function rebuildSessionsTable(db) {
  db.exec(sessionsTable('sessions_migrating'));
  db.exec(`
    INSERT INTO sessions_migrating (id, posture, started_at, ended_at)
    SELECT id, posture, started_at, ended_at FROM sessions;
  `);
  db.exec('DROP TABLE sessions');
  db.exec('ALTER TABLE sessions_migrating RENAME TO sessions');
  db.exec(SESSION_INDEXES);
}

/**
 * Bring the file up to `SCHEMA_VERSION`, or refuse to touch it.
 *
 * Version 0 covers two cases that look alike from the outside: a brand new
 * file, and one written before `away` existed. The first needs creating, the
 * second needs its posture constraint widened without losing any sessions.
 */
function migrate(db) {
  const found = schemaVersion(db);
  if (found === SCHEMA_VERSION) return;
  if (found > SCHEMA_VERSION) {
    throw new Error(
      `This database was written by a newer version of the tracker ` +
        `(schema ${found}, this build understands ${SCHEMA_VERSION}). Update the app rather than downgrading the data.`,
    );
  }

  db.exec('BEGIN IMMEDIATE');
  try {
    if (found === 0) {
      const hadSessions = tableExists(db, 'sessions');
      if (hadSessions) {
        rebuildSessionsTable(db);
      } else {
        db.exec(sessionsTable('sessions'));
        db.exec(SESSION_INDEXES);
      }
      db.exec(SETTINGS_TABLE);
    }
    // Version 2 only adds a table, so it needs no rebuild.
    db.exec(CONFLICTS_TABLE);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/**
 * A refusal a caller can act on: `code` says why, so the API can map it to a
 * status and the interface can say something useful.
 */
export class EditError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'EditError';
    this.code = code;
  }
}

const notFound = (id) => new EditError('NOT_FOUND', `There is no session ${id}.`);
const invalid = (message) => new EditError('INVALID', message);

function assertPostureOrRefuse(posture) {
  if (!POSTURES.includes(posture)) {
    throw invalid(`${JSON.stringify(posture)} is not a posture.`);
  }
}

/** An open session has no end, so treat it as running to the end of time. */
const OPEN_END = Number.MAX_SAFE_INTEGER;

function assertPosture(posture) {
  if (!POSTURES.includes(posture)) {
    throw new TypeError(
      `Unknown posture ${JSON.stringify(posture)}; expected one of ${POSTURE_LIST}.`,
    );
  }
}

function assertTimestamp(value, label = 'timestamp') {
  if (!Number.isFinite(value)) {
    throw new TypeError(`Invalid ${label}: ${JSON.stringify(value)}`);
  }
  return Math.trunc(value);
}

/**
 * Open (and if necessary create) the database.
 * Defaults to an in-memory database, which is what the tests use.
 */
export function openDatabase(location = ':memory:') {
  const db = new DatabaseSync(location);
  if (location !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  try {
    migrate(db);
  } catch (error) {
    db.close();
    throw error;
  }
  return createStore(db);
}

function createStore(db) {
  const statements = {
    open: db.prepare(`SELECT ${COLUMNS} FROM sessions WHERE ended_at IS NULL`),
    insert: db.prepare('INSERT INTO sessions (posture, started_at, ended_at) VALUES (?, ?, ?)'),
    close: db.prepare('UPDATE sessions SET ended_at = ? WHERE id = ?'),
    all: db.prepare(`SELECT ${COLUMNS} FROM sessions ORDER BY started_at, id`),
    overlapping: db.prepare(
      `SELECT ${COLUMNS} FROM sessions
       WHERE started_at < ? AND (ended_at IS NULL OR ended_at > ?)
       ORDER BY started_at, id`,
    ),
    byId: db.prepare(`SELECT ${COLUMNS} FROM sessions WHERE id = ?`),
    remove: db.prepare('DELETE FROM sessions WHERE id = ?'),
    update: db.prepare('UPDATE sessions SET posture = ?, started_at = ?, ended_at = ? WHERE id = ?'),
    clashes: db.prepare(
      `SELECT ${COLUMNS} FROM sessions
       WHERE id IS NOT ?
         AND started_at < ?
         AND COALESCE(ended_at, ${OPEN_END}) > ?
       LIMIT 1`,
    ),
    addConflict: db.prepare(
      `INSERT INTO conflicts
         (queued_posture, queued_at, existing_session_id, existing_posture,
          existing_started_at, existing_ended_at, noticed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ),
    openConflicts: db.prepare(
      'SELECT * FROM conflicts WHERE resolved_at IS NULL ORDER BY queued_at',
    ),
    conflictById: db.prepare('SELECT * FROM conflicts WHERE id = ?'),
    resolveConflict: db.prepare(
      'UPDATE conflicts SET resolved_at = ?, resolution = ? WHERE id = ?',
    ),
    readSettings: db.prepare('SELECT key, value FROM settings'),
    writeSetting: db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ' +
      'ON CONFLICT (key) DO UPDATE SET value = excluded.value'),
  };

  /** Run `work` in a transaction, rolling back if it throws. */
  function transaction(work) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  const currentSession = () => statements.open.get() ?? null;
  const sessionById = (id) => statements.byId.get(id) ?? null;
  const lastInserted = () => sessionById(db.prepare('SELECT last_insert_rowid() AS id').get().id);
  const lastConflict = () =>
    statements.conflictById.get(db.prepare('SELECT last_insert_rowid() AS id').get().id);

  /**
   * Refuse a span that runs backwards or lands on top of another session.
   * `exceptId` is the session being edited, which may of course overlap itself.
   */
  function assertFreeSpan({ startedAt, endedAt, exceptId = null }) {
    if (!Number.isFinite(startedAt)) throw invalid('A session needs a start time.');
    if (endedAt !== null && !Number.isFinite(endedAt)) {
      throw invalid('That end time is not a time.');
    }
    if (endedAt !== null && endedAt <= startedAt) {
      throw invalid('A session has to end after it starts.');
    }

    const clash = statements.clashes.get(exceptId, endedAt ?? OPEN_END, startedAt);
    if (clash) {
      // The server runs on the same machine as the page, so local time is the
      // time the person reading this is actually looking at.
      const when = new Date(clash.started_at).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
      });
      throw new EditError(
        'OVERLAP',
        `That would overlap the ${clash.posture} block starting at ${when}.`,
      );
    }
  }

  return {
    currentSession,
    session: sessionById,

    /**
     * Record the posture from `now` onwards, closing whatever was running.
     * Setting the posture that is already current is a no-op, which keeps the
     * endpoint safe to retry.
     *
     * If the clock has gone backwards, the switch is treated as happening at
     * the open session's own start, so sessions stay contiguous and no session
     * can run backwards.
     */
    setPosture(posture, now) {
      assertPosture(posture);
      const at = assertTimestamp(now, 'time');

      const open = currentSession();
      if (open && open.posture === posture) return open;

      const startedAt = open ? Math.max(at, open.started_at) : at;
      return transaction(() => {
        if (open) statements.close.run(startedAt, open.id);
        statements.insert.run(posture, startedAt, null);
        return currentSession();
      });
    },

    /** End the open session, if any, and leave nothing running. */
    stopTracking(now) {
      const at = assertTimestamp(now, 'time');
      const open = currentSession();
      if (!open) return null;

      statements.close.run(Math.max(at, open.started_at), open.id);
      return { ...open, ended_at: Math.max(at, open.started_at) };
    },

    /** Every session overlapping `[from, to)`, including one still open. */
    sessionsBetween(from, to) {
      return statements.overlapping.all(assertTimestamp(to, 'range end'), assertTimestamp(from, 'range start'));
    },

    allSessions() {
      return statements.all.all();
    },

    getSettings() {
      return parseSettings(statements.readSettings.all());
    },

    /** Persist an already-validated settings object. */
    saveSettings(settings) {
      return transaction(() => {
        for (const { key, value } of serializeSettings(settings)) {
          statements.writeSetting.run(key, value);
        }
        return this.getSettings();
      });
    },

    /**
     * Correct a recorded session: its posture, either boundary, or both.
     * Anything omitted is left as it is.
     */
    updateSession(id, changes = {}) {
      const existing = sessionById(id);
      if (!existing) throw notFound(id);

      const posture = changes.posture ?? existing.posture;
      if (!POSTURES.includes(posture)) {
        throw invalid(`${JSON.stringify(changes.posture)} is not a posture.`);
      }

      const startedAt = 'started_at' in changes ? changes.started_at : existing.started_at;
      const endedAt = 'ended_at' in changes ? changes.ended_at : existing.ended_at;
      assertFreeSpan({ startedAt, endedAt, exceptId: id });

      statements.update.run(posture, startedAt, endedAt, id);
      return sessionById(id);
    },

    /**
     * Cut a session in two at `at`, giving the later half a different posture.
     * This is how a switch you forgot to record gets put back.
     */
    splitSession(id, at, posture) {
      const existing = sessionById(id);
      if (!existing) throw notFound(id);
      assertPostureOrRefuse(posture);

      if (posture === existing.posture) {
        throw invalid('Splitting into the same posture would change nothing.');
      }
      const finish = existing.ended_at ?? OPEN_END;
      if (!Number.isFinite(at) || at <= existing.started_at || at >= finish) {
        throw invalid('Split somewhere inside the session, not at or beyond its edges.');
      }

      return transaction(() => {
        // Shorten the original first, so the second half has room to land.
        statements.update.run(existing.posture, existing.started_at, at, id);
        statements.insert.run(posture, at, existing.ended_at);
        return [sessionById(id), lastInserted()];
      });
    },

    deleteSession(id) {
      if (!sessionById(id)) throw notFound(id);
      statements.remove.run(id);
      return true;
    },

    /** Add a block that was never recorded, into a gap between sessions. */
    insertSession({ posture, started_at: startedAt, ended_at: endedAt = null }) {
      assertPostureOrRefuse(posture);
      assertFreeSpan({ startedAt, endedAt });

      statements.insert.run(posture, startedAt, endedAt);
      return lastInserted();
    },

    /**
     * Insert a session row directly, bypassing the toggle rules.
     * Only for tests and for restoring an export; the schema still applies.
     */
    unsafeInsertSession({ posture, started_at: startedAt, ended_at: endedAt = null }) {
      assertPosture(posture);
      statements.insert.run(
        posture,
        assertTimestamp(startedAt, 'started_at'),
        endedAt === null ? null : assertTimestamp(endedAt, 'ended_at'),
      );
      return true;
    },

    /** Record a disagreement for someone to settle later. */
    recordConflict({ posture, at, existing }, noticedAt) {
      statements.addConflict.run(
        posture,
        at,
        existing?.id ?? null,
        existing?.posture ?? null,
        existing?.started_at ?? null,
        existing?.ended_at ?? null,
        noticedAt,
      );
      return lastConflict();
    },

    openConflicts() {
      return statements.openConflicts.all();
    },

    conflict(id) {
      return statements.conflictById.get(id) ?? null;
    },

    settleConflict(id, resolution, at) {
      statements.resolveConflict.run(at, resolution, id);
      return statements.conflictById.get(id) ?? null;
    },

    /** The schema version recorded in the file. */
    schemaVersion() {
      return schemaVersion(db);
    },

    close() {
      db.close();
    },
  };
}

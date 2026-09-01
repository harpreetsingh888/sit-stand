/**
 * The HTTP surface: routing, request validation, and the JSON envelope.
 *
 * Every response is `{ok, data, error}`. The store and the clock are both
 * injected, so the whole API can be exercised against an in-memory database
 * and a clock the tests move by hand.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildDay, parseDayKey, todayKey } from './day.js';
import { EditError } from './db.js';
import { validateSettings } from './settings.js';
import { classifyAction } from './sync.js';
import { createBroadcaster } from './events.js';
import { closeStrandedSessions } from './worktime.js';
import {
  aggregateDaily,
  dayRange,
  goalProgress,
  localDayKey,
  shiftDayKey,
  workWindowForDayKey,
} from './stats.js';

const DEFAULT_HISTORY_DAYS = 14;
const MAX_HISTORY_DAYS = 366;
const MAX_BODY_BYTES = 64 * 1024;

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));

const CONTENT_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.ico', 'image/x-icon'],
  ['.webmanifest', 'application/manifest+json'],
]);

class RequestError extends Error {
  constructor(status, message, fields) {
    super(message);
    this.status = status;
    this.fields = fields;
  }
}

const EDIT_STATUS = { NOT_FOUND: 404, OVERLAP: 409, INVALID: 400 };

/** Run a store edit, turning its refusals into the right HTTP status. */
function edit(work) {
  try {
    return work();
  } catch (error) {
    if (error instanceof EditError) {
      throw new RequestError(EDIT_STATUS[error.code] ?? 400, error.message);
    }
    throw error;
  }
}

/** A timestamp given as a value rather than a named field. */
function readTime(value) {
  if (!Number.isFinite(value)) {
    throw new RequestError(400, '"at" must be a time in milliseconds.');
  }
  return value;
}

/** A timestamp from a request body, or a refusal naming the field. */
function requireTime(body, field) {
  const value = body[field];
  if (!Number.isFinite(value)) {
    throw new RequestError(400, `"${field}" must be a time in milliseconds.`);
  }
  return value;
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

const sendData = (res, data) => sendJson(res, 200, { ok: true, data, error: null });

function sendError(res, status, message, fields) {
  sendJson(res, status, { ok: false, data: null, error: fields ? { message, fields } : { message } });
}

/** Read a JSON request body. An empty body is an empty object. */
async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new RequestError(413, 'Request body is too large.');
    chunks.push(chunk);
  }

  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (raw === '') return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not an object');
    }
    return parsed;
  } catch {
    throw new RequestError(400, 'Request body must be a JSON object.');
  }
}

/** Resolve a URL path inside the public directory, or null if it escapes. */
function resolvePublicPath(urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;

  const relative = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  const resolved = path.resolve(PUBLIC_DIR, relative);
  return resolved.startsWith(PUBLIC_DIR) ? resolved : null;
}

/** A snapshot of right now: what is running, today's totals, goal progress. */
function buildState(store, nowMs) {
  const settings = store.getSettings();
  closeStrandedSessions(store, settings, nowMs);
  const todayKey = localDayKey(nowMs);
  const { start, end } = dayRange(todayKey);

  const sessions = store.sessionsBetween(start, end);
  const [today] = aggregateDaily(sessions, settings, {
    now: nowMs,
    fromDayKey: todayKey,
    toDayKey: todayKey,
  });

  const session = store.currentSession();
  const window = workWindowForDayKey(todayKey, settings);

  return {
    now: nowMs,
    today,
    goal: goalProgress(today.stand, settings),
    session: session
      ? { ...session, elapsedMs: Math.max(0, nowMs - session.started_at) }
      : null,
    workWindow: window,
    withinWorkHours: Boolean(window && nowMs >= window.start && nowMs < window.end),
    conflicts: store.openConflicts(),
    settings,
  };
}

function parseHistoryDays(raw) {
  if (raw === null || raw === '') return DEFAULT_HISTORY_DAYS;
  if (!/^\d+$/.test(raw)) {
    throw new RequestError(400, `The "days" parameter must be a whole number of days.`);
  }
  const days = Number(raw);
  if (days < 1 || days > MAX_HISTORY_DAYS) {
    throw new RequestError(400, `The "days" parameter must be between 1 and ${MAX_HISTORY_DAYS}.`);
  }
  return days;
}

const csvCell = (value) => {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

const isoOrBlank = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : '');

/**
 * Build the request handler.
 * `now` is injected so tests can control the clock.
 */
export function createRequestHandler({
  store,
  now = () => Date.now(),
  broadcaster = createBroadcaster(),
}) {
  /**
   * Hand the new state to every open page, then answer the request that caused
   * it. Called after anything that changes what is recorded.
   */
  function announce() {
    const state = buildState(store, now());
    broadcaster.broadcast('state', state);
    return state;
  }

  const routes = {
    '/api/state': {
      GET: (req, res) => sendData(res, buildState(store, now())),
    },

    '/api/events': {
      GET: (req, res) => {
        broadcaster.add(res);
        // The page should not have to ask what it missed while connecting.
        res.write(`event: state\ndata: ${JSON.stringify(buildState(store, now()))}\n\n`);
      },
    },

    '/api/toggle': {
      POST: async (req, res) => {
        const body = await readJson(req);
        const nowMs = now();
        // A client may say when a switch really happened - a Mac reporting the
        // moment it went to sleep, or a phone replaying something it queued
        // while offline. It can never be in the future.
        const when = 'at' in body ? Math.min(readTime(body.at), nowMs) : nowMs;

        const current = store.currentSession();
        const requested =
          body.posture ?? (current ? (current.posture === 'sit' ? 'stand' : 'sit') : 'sit');

        try {
          store.setPosture(requested, when);
        } catch (error) {
          throw new RequestError(400, error.message);
        }
        sendData(res, announce());
      },
    },

    '/api/stop': {
      POST: async (req, res) => {
        const body = await readJson(req);
        const nowMs = now();
        store.stopTracking('at' in body ? Math.min(readTime(body.at), nowMs) : nowMs);
        sendData(res, announce());
      },
    },

    '/api/history': {
      GET: (req, res, url) => {
        const days = parseHistoryDays(url.searchParams.get('days'));
        const nowMs = now();
        const settings = store.getSettings();

        const toDayKey = localDayKey(nowMs);
        const fromDayKey = shiftDayKey(toDayKey, -(days - 1));
        const sessions = store.sessionsBetween(dayRange(fromDayKey).start, dayRange(toDayKey).end);

        sendData(res, {
          days: aggregateDaily(sessions, settings, { now: nowMs, fromDayKey, toDayKey }),
          settings,
        });
      },
    },

    '/api/settings': {
      GET: (req, res) => sendData(res, { settings: store.getSettings() }),
      PUT: async (req, res) => {
        const patch = await readJson(req);
        const result = validateSettings(patch, store.getSettings());
        if (!result.ok) {
          throw new RequestError(400, 'Those settings cannot be used.', result.errors);
        }
        const settings = store.saveSettings(result.value);
        announce();
        sendData(res, { settings });
      },
    },

    '/api/day': {
      GET: (req, res, url) => {
        const requested = url.searchParams.get('day');
        const dayKey = requested === null ? todayKey(now()) : parseDayKey(requested);
        if (dayKey === null) {
          throw new RequestError(400, `"day" must be a real date written as YYYY-MM-DD.`);
        }
        sendData(res, buildDay(store, now(), dayKey));
      },
    },

    '/api/sessions': {
      POST: async (req, res) => {
        const body = await readJson(req);
        const added = edit(() =>
          store.insertSession({
            posture: body.posture,
            started_at: requireTime(body, 'started_at'),
            ended_at: body.ended_at ?? null,
          }),
        );
        announce();
        sendData(res, buildDay(store, now(), todayKey(added.started_at)));
      },
    },

    '/api/sessions/:id': {
      PATCH: async (req, res, url, { id }) => {
        const body = await readJson(req);
        const changes = {};
        if ('posture' in body) changes.posture = body.posture;
        if ('started_at' in body) changes.started_at = body.started_at;
        if ('ended_at' in body) changes.ended_at = body.ended_at;

        const updated = edit(() => store.updateSession(id, changes));
        announce();
        sendData(res, buildDay(store, now(), todayKey(updated.started_at)));
      },

      DELETE: (req, res, url, { id }) => {
        const doomed = store.session(id);
        edit(() => store.deleteSession(id));
        announce();
        sendData(res, buildDay(store, now(), todayKey(doomed.started_at)));
      },
    },

    '/api/sessions/:id/split': {
      POST: async (req, res, url, { id }) => {
        const body = await readJson(req);
        const [first] = edit(() =>
          store.splitSession(id, requireTime(body, 'at'), body.posture),
        );
        announce();
        sendData(res, buildDay(store, now(), todayKey(first.started_at)));
      },
    },

    '/api/sync': {
      POST: async (req, res) => {
        const body = await readJson(req);
        if (!Array.isArray(body.actions)) {
          throw new RequestError(400, '"actions" must be a list of queued switches.');
        }

        const nowMs = now();
        let applied = 0;
        let rejected = 0;

        // Oldest first, so a queue replays in the order it happened.
        for (const action of [...body.actions].sort((a, b) => (a?.at ?? 0) - (b?.at ?? 0))) {
          const { start, end } = dayRange(todayKey(action?.at ?? nowMs));
          const verdict = classifyAction(action, store.sessionsBetween(start, end));

          if (verdict.kind === 'invalid') {
            rejected += 1;
          } else if (verdict.kind === 'conflict') {
            store.recordConflict({ ...action, existing: verdict.existing }, nowMs);
          } else if (verdict.kind === 'apply') {
            store.setPosture(action.posture, Math.min(action.at, nowMs));
            applied += 1;
          }
        }

        sendData(res, {
          applied,
          rejected,
          conflicts: store.openConflicts(),
          state: announce(),
        });
      },
    },

    '/api/conflicts/:id/resolve': {
      POST: async (req, res, url, { id }) => {
        const body = await readJson(req);
        if (body.choice !== 'existing' && body.choice !== 'queued') {
          throw new RequestError(400, 'Choose either "existing" or "queued".');
        }

        const conflict = store.conflict(id);
        if (!conflict) throw new RequestError(404, `There is no conflict ${id}.`);
        if (conflict.resolved_at !== null) {
          throw new RequestError(409, 'That one has already been settled.');
        }

        if (body.choice === 'queued') {
          // Believing the phone means cutting the recorded block at that moment
          // and giving the remainder the posture the phone reported.
          edit(() =>
            store.splitSession(
              conflict.existing_session_id,
              conflict.queued_at,
              conflict.queued_posture,
            ),
          );
        }
        store.settleConflict(id, body.choice, now());

        sendData(res, { conflicts: store.openConflicts(), state: announce() });
      },
    },

    '/api/export.csv': {
      GET: (req, res) => {
        const rows = store.allSessions().map((session) =>
          [
            session.id,
            session.posture,
            session.started_at,
            session.ended_at,
            isoOrBlank(session.started_at),
            isoOrBlank(session.ended_at),
          ]
            .map(csvCell)
            .join(','),
        );

        const csv = ['id,posture,started_at,ended_at,started_iso,ended_iso', ...rows].join('\n') + '\n';
        res.writeHead(200, {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': 'attachment; filename="sit-stand.csv"',
          'cache-control': 'no-store',
        });
        res.end(csv);
      },
    },
  };

  async function serveStatic(req, res, url) {
    const filePath = resolvePublicPath(url.pathname);
    if (!filePath) return sendError(res, 403, 'That path is not allowed.');

    try {
      const file = await fs.readFile(filePath);
      res.writeHead(200, {
        'content-type': CONTENT_TYPES.get(path.extname(filePath)) ?? 'application/octet-stream',
        'content-length': file.length,
        'cache-control': 'no-cache',
      });
      res.end(file);
    } catch {
      sendError(res, 404, 'Not found.');
    }
  }

  // Routes carrying `:id` become patterns; the rest stay exact string matches.
  const patterned = Object.entries(routes)
    .filter(([path]) => path.includes(':id'))
    .map(([path, methods]) => ({
      pattern: new RegExp(`^${path.replace('/:id', '/(\\d+)')}$`),
      methods,
    }));

  /** The handlers for a path, plus any parameters captured from it. */
  function matchRoute(pathname) {
    if (routes[pathname] && !pathname.includes(':id')) {
      return { methods: routes[pathname], params: {} };
    }
    for (const { pattern, methods } of patterned) {
      const found = pattern.exec(pathname);
      if (found) return { methods, params: { id: Number(found[1]) } };
    }
    return null;
  }

  return async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');

    try {
      const route = matchRoute(url.pathname);
      if (route) {
        const handler = route.methods[req.method];
        if (!handler) {
          res.setHeader('allow', Object.keys(route.methods).join(', '));
          return sendError(res, 405, `${req.method} is not allowed on ${url.pathname}.`);
        }
        return await handler(req, res, url, route.params);
      }

      if (url.pathname.startsWith('/api/')) {
        return sendError(res, 404, `No such endpoint: ${url.pathname}`);
      }
      if (req.method !== 'GET') {
        return sendError(res, 405, `${req.method} is not allowed here.`);
      }
      return await serveStatic(req, res, url);
    } catch (error) {
      if (error instanceof RequestError) {
        return sendError(res, error.status, error.message, error.fields);
      }
      console.error('Unhandled request error:', error);
      return sendError(res, 500, 'Something went wrong handling that request.');
    }
  };
}

/**
 * Turning raw posture sessions into statistics.
 *
 * Sessions are stored exactly as they happened. Everything here is applied at
 * read time: clipping to the configured work window, splitting at local-day
 * boundaries, and totalling. That is what lets the work hours change without
 * rewriting history, and what stops a session left running overnight from
 * reporting fourteen hours of sitting.
 *
 * Every function is pure. The current time is always passed in.
 */

import { POSTURES, isPosture } from './postures.js';

const MS_PER_MINUTE = 60_000;
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DAY_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Noon is a safe anchor for day arithmetic: no daylight-saving jump lands on it. */
const ANCHOR_HOUR = 12;

const pad2 = (n) => String(n).padStart(2, '0');

/** Milliseconds, or null for anything that is not a usable timestamp. */
function toMs(value) {
  if (typeof value === 'bigint') return Number(value);
  if (typeof value !== 'number') return null;
  return Number.isFinite(value) ? value : null;
}

function parseDayKey(key) {
  const match = DAY_KEY.exec(key ?? '');
  if (!match) throw new TypeError(`Not a day key: ${JSON.stringify(key)}`);
  return { year: Number(match[1]), month: Number(match[2]) - 1, date: Number(match[3]) };
}

/** Minutes since local midnight for an "HH:MM" string, or null if malformed. */
function minutesOfDay(hhmm) {
  const match = HHMM.exec(hhmm ?? '');
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

/** The local calendar day containing a timestamp, as "YYYY-MM-DD". */
export function localDayKey(ms) {
  const date = new Date(ms);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/** Local midnight-to-midnight bounds of a day. Not always 24h: DST days differ. */
export function dayRange(dayKey) {
  const { year, month, date } = parseDayKey(dayKey);
  return {
    start: new Date(year, month, date, 0, 0, 0, 0).getTime(),
    end: new Date(year, month, date + 1, 0, 0, 0, 0).getTime(),
  };
}

/** Every day key from `fromDayKey` to `toDayKey`, inclusive. */
export function dayKeysBetween(fromDayKey, toDayKey) {
  const from = parseDayKey(fromDayKey);
  const to = parseDayKey(toDayKey);
  const cursor = new Date(from.year, from.month, from.date, ANCHOR_HOUR, 0, 0, 0);
  const last = new Date(to.year, to.month, to.date, ANCHOR_HOUR, 0, 0, 0).getTime();

  const keys = [];
  while (cursor.getTime() <= last) {
    keys.push(localDayKey(cursor.getTime()));
    cursor.setDate(cursor.getDate() + 1);
  }
  return keys;
}

/** The day key `deltaDays` away, stepping in whole local days across DST. */
export function shiftDayKey(dayKey, deltaDays) {
  const { year, month, date } = parseDayKey(dayKey);
  const cursor = new Date(year, month, date, ANCHOR_HOUR, 0, 0, 0);
  cursor.setDate(cursor.getDate() + deltaDays);
  return localDayKey(cursor.getTime());
}

/**
 * The working window on a given day, or null if it is not a working day.
 * Built from local wall-clock time, so a window crossing a daylight-saving
 * change is shorter or longer in real elapsed milliseconds - which is correct.
 */
export function workWindowForDayKey(dayKey, settings) {
  const { year, month, date } = parseDayKey(dayKey);
  const weekday = new Date(year, month, date, ANCHOR_HOUR, 0, 0, 0).getDay();

  const workDays = Array.isArray(settings?.workDays) ? settings.workDays : [];
  if (!workDays.includes(weekday)) return null;

  const startMinutes = minutesOfDay(settings?.workStart);
  const endMinutes = minutesOfDay(settings?.workEnd);
  if (startMinutes === null || endMinutes === null || endMinutes <= startMinutes) return null;

  return {
    start: new Date(year, month, date, 0, startMinutes, 0, 0).getTime(),
    end: new Date(year, month, date, 0, endMinutes, 0, 0).getTime(),
  };
}

/**
 * How much of one session falls inside working hours, split by local day.
 *
 * An unfinished session (`ended_at === null`) is measured up to `now`. A
 * finished one is taken at face value. Anything malformed, reversed or
 * zero-length contributes nothing rather than throwing or going negative.
 */
export function sessionContributions(session, settings, options = {}) {
  const { now, rangeStart = -Infinity, rangeEnd = Infinity } = options;

  const posture = session?.posture;
  if (!isPosture(posture)) return [];

  const startedAt = toMs(session.started_at);
  const isOpen = session.ended_at === null || session.ended_at === undefined;
  const endedAt = toMs(isOpen ? now : session.ended_at);
  if (startedAt === null || endedAt === null) return [];

  const start = Math.max(startedAt, rangeStart);
  const end = Math.min(endedAt, rangeEnd);
  if (!(end > start)) return [];

  const contributions = [];
  // `end - 1` keeps a session ending exactly at midnight out of the next day.
  for (const dayKey of dayKeysBetween(localDayKey(start), localDayKey(end - 1))) {
    const window = workWindowForDayKey(dayKey, settings);
    if (!window) continue;

    const ms = Math.min(end, window.end) - Math.max(start, window.start);
    if (ms > 0) contributions.push({ day: dayKey, posture, ms });
  }
  return contributions;
}

/**
 * Per-day sitting and standing totals across an inclusive range of days.
 * Days with no activity are present with zeroes so callers can chart a
 * continuous run of days without filling gaps themselves.
 */
export function aggregateDaily(sessions, settings, { now, fromDayKey, toDayKey }) {
  const dayKeys = dayKeysBetween(fromDayKey, toDayKey);
  const byDay = new Map(
    dayKeys.map((day) => [
      day,
      {
        day,
        isWorkDay: workWindowForDayKey(day, settings) !== null,
        ...Object.fromEntries(POSTURES.map((posture) => [posture, 0])),
      },
    ]),
  );

  const rangeStart = dayRange(fromDayKey).start;
  const rangeEnd = dayRange(toDayKey).end;

  for (const session of sessions ?? []) {
    for (const { day, posture, ms } of sessionContributions(session, settings, {
      now,
      rangeStart,
      rangeEnd,
    })) {
      const totals = byDay.get(day);
      if (totals) totals[posture] += ms;
    }
  }

  return dayKeys.map((day) => byDay.get(day));
}

/** Progress towards the daily standing goal. The ratio is clamped for drawing. */
export function goalProgress(standMs, settings) {
  const goalMinutes = Number(settings?.standGoalMinutes);
  const goalMs = Number.isFinite(goalMinutes) && goalMinutes > 0 ? goalMinutes * MS_PER_MINUTE : 0;
  const standing = Math.max(0, toMs(standMs) ?? 0);

  if (goalMs <= 0) {
    return { goalMs: 0, standMs: standing, ratio: 1, remainingMs: 0, met: true };
  }
  return {
    goalMs,
    standMs: standing,
    ratio: Math.min(1, standing / goalMs),
    remainingMs: Math.max(0, goalMs - standing),
    met: standing >= goalMs,
  };
}

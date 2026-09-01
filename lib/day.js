/**
 * One day, block by block.
 *
 * The rest of the app deals in totals. This deals in the individual sessions
 * that produced them, which is what you need to look at the record and correct
 * it — and what lets a stretch too long to be believable get flagged.
 */

import { POSTURES } from './postures.js';
import { aggregateDaily, dayRange, localDayKey, workWindowForDayKey } from './stats.js';

const MS_PER_MINUTE = 60_000;
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Validate a `YYYY-MM-DD` string, rejecting both malformed text and dates that
 * do not exist. Returns null if it is not usable.
 */
export function parseDayKey(value) {
  if (typeof value !== 'string' || !DAY_KEY.test(value)) return null;

  const [year, month, date] = value.split('-').map(Number);
  const probe = new Date(year, month - 1, date, 12, 0, 0, 0);
  const real =
    probe.getFullYear() === year && probe.getMonth() === month - 1 && probe.getDate() === date;
  return real ? value : null;
}

/**
 * Everything needed to draw and edit a single day: its blocks, its totals, its
 * work window, and which blocks look like a toggle someone forgot to press.
 */
export function buildDay(store, nowMs, dayKey) {
  const settings = store.getSettings();
  const { start, end } = dayRange(dayKey);

  const raw = store.sessionsBetween(start, end);
  const [totals] = aggregateDaily(raw, settings, {
    now: nowMs,
    fromDayKey: dayKey,
    toDayKey: dayKey,
  });

  const implausibleAfterMs = settings.implausibleAfterMinutes * MS_PER_MINUTE;
  const sessions = raw.map((session) => {
    // An unfinished block is measured to now; a finished one to its own end.
    const finish = session.ended_at ?? nowMs;
    const ms = Math.max(0, finish - session.started_at);
    return { ...session, ms, implausible: ms >= implausibleAfterMs };
  });

  return {
    now: nowMs,
    day: dayKey,
    isWorkDay: totals.isWorkDay,
    workWindow: workWindowForDayKey(dayKey, settings),
    totals: Object.fromEntries(POSTURES.map((posture) => [posture, totals[posture]])),
    sessions,
    implausibleCount: sessions.filter((session) => session.implausible).length,
    settings,
  };
}

/** The day a timestamp belongs to, for defaulting the day view to today. */
export const todayKey = (nowMs) => localDayKey(nowMs);

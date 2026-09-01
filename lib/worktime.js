/**
 * Making the working day govern tracking, not just the statistics.
 *
 * Clipping to the work window decides what the numbers say. It does not stop a
 * timer running all night. This closes blocks that outlived the day they
 * belong to, so the app starts and stops with the working day the way the
 * settings describe.
 */

import { dayRange, localDayKey, workWindowForDayKey } from './stats.js';

/**
 * The moment a block that began at `startedAt` should be considered finished,
 * or null if its day is still in progress.
 *
 * A block from a working day ends at that day's closing time. A block begun
 * outside any working window has nowhere to run to, so it ends where it began
 * and contributes nothing.
 */
export function endOfDayFor(startedAt, settings, nowMs) {
  const dayKey = localDayKey(startedAt);
  const window = workWindowForDayKey(dayKey, settings);
  const midnight = dayRange(dayKey).end;

  // Begun on a day off, or deliberately after the working day had already
  // finished. There is no working day to end it, and cutting it off the moment
  // it starts would make the button appear broken - so let the calendar day
  // end it, which stops it running for weeks. It counts for nothing either way.
  if (!window || startedAt >= window.end) {
    return nowMs >= midnight ? midnight : null;
  }
  return nowMs >= window.end ? window.end : null;
}

/**
 * Close any block still open after its working day finished.
 * Returns what was closed, so a caller can log it. Safe to run on a timer.
 */
export function closeStrandedSessions(store, settings, nowMs) {
  if (settings.autoStopAtWorkEnd === false) return [];

  const open = store.currentSession();
  if (!open) return [];

  const finish = endOfDayFor(open.started_at, settings, nowMs);
  if (finish === null) return [];

  store.stopTracking(finish);
  return [{ ...open, ended_at: finish }];
}

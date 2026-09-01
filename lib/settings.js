/**
 * Settings: defaults, parsing what is stored, and validation.
 *
 * Validation is cross-field on purpose. A time can be well-formed and still
 * wrong (an end before a start), and a standing goal can be a sensible number
 * and still impossible (longer than the working day). Both are caught here so
 * neither the database nor the statistics ever see an incoherent combination.
 */

const TIME_OF_DAY = /^([01]\d|2[0-3]):([0-5]\d)$/;
const MINUTES_IN_DAY = 24 * 60;
const MAX_NUDGE_MINUTES = 480;
/** Below about half an hour, ordinary stretches would be flagged constantly. */
const MIN_IMPLAUSIBLE_MINUTES = 30;

/** The only keys that are stored. Anything else in a patch is discarded. */
export const SETTING_KEYS = Object.freeze([
  'workStart',
  'workEnd',
  'workDays',
  'standGoalMinutes',
  'sitNudgeMinutes',
  'standNudgeMinutes',
  'implausibleAfterMinutes',
  'autoStopAtWorkEnd',
]);

export const DEFAULT_SETTINGS = Object.freeze({
  workStart: '09:00',
  workEnd: '18:00',
  workDays: Object.freeze([1, 2, 3, 4, 5]),
  standGoalMinutes: 120,
  sitNudgeMinutes: 50,
  standNudgeMinutes: 20,
  // Longer than this in one unbroken posture and it is probably a toggle you
  // forgot to press rather than something you actually did.
  implausibleAfterMinutes: 180,
  // The working day ends the day's tracking. Turn this off if you often carry
  // on past your finish time and want that recorded.
  autoStopAtWorkEnd: true,
});

/** A mutable copy of the defaults; the exported object itself stays frozen. */
function freshDefaults() {
  return { ...DEFAULT_SETTINGS, workDays: [...DEFAULT_SETTINGS.workDays] };
}

/** Minutes since midnight, or null if the value is not an "HH:MM" string. */
function minutesOfDay(value) {
  const match = typeof value === 'string' ? TIME_OF_DAY.exec(value) : null;
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

/** Accepts the numeric strings that HTML form fields produce. */
function asNumber(value) {
  if (typeof value === 'string' && value.trim() !== '') return Number(value);
  return value;
}

function checkTime(value, label) {
  if (minutesOfDay(value) !== null) return { ok: true, value };
  return { ok: false, message: `${label} must be a 24-hour time such as 09:00.` };
}

function checkWorkDays(value) {
  const message = 'Working days must be whole numbers from 0 (Sunday) to 6 (Saturday).';
  if (!Array.isArray(value) || value.length === 0) {
    return { ok: false, message: 'Pick at least one working day.' };
  }

  const days = [];
  for (const entry of value) {
    const day = asNumber(entry);
    if (!Number.isInteger(day) || day < 0 || day > 6) return { ok: false, message };
    if (!days.includes(day)) days.push(day);
  }
  return { ok: true, value: days.sort((a, b) => a - b) };
}

function checkMinutes(value, label, max, min = 1) {
  const minutes = asNumber(value);
  if (!Number.isInteger(minutes) || minutes < min || minutes > max) {
    return {
      ok: false,
      message: `${label} must be a whole number of minutes between ${min} and ${max}.`,
    };
  }
  return { ok: true, value: minutes };
}

/**
 * Merge a partial patch onto the current settings and validate the result.
 * Returns either `{ok: true, value}` with a complete, normalised settings
 * object, or `{ok: false, errors}` naming every field that is wrong.
 */
export function validateSettings(patch, current = DEFAULT_SETTINGS) {
  const merged = { ...freshDefaults(), ...pickKnown(current), ...pickKnown(patch) };
  const errors = [];
  const value = {};

  const start = checkTime(merged.workStart, 'Work start');
  if (start.ok) value.workStart = start.value;
  else errors.push({ field: 'workStart', message: start.message });

  const end = checkTime(merged.workEnd, 'Work end');
  if (end.ok) value.workEnd = end.value;
  else errors.push({ field: 'workEnd', message: end.message });

  // A window only exists if both ends parsed and it moves forward in time.
  let windowMinutes = null;
  if (start.ok && end.ok) {
    const span = minutesOfDay(end.value) - minutesOfDay(start.value);
    if (span <= 0) {
      errors.push({ field: 'workEnd', message: 'Work end must be after work start.' });
    } else {
      windowMinutes = span;
    }
  }

  const days = checkWorkDays(merged.workDays);
  if (days.ok) value.workDays = days.value;
  else errors.push({ field: 'workDays', message: days.message });

  // Without a valid window, only sanity-check the goal; the fit check would
  // just be noise on top of the error the user actually has to fix.
  const goalCeiling = windowMinutes ?? MINUTES_IN_DAY;
  const goal = checkMinutes(merged.standGoalMinutes, 'The standing goal', goalCeiling);
  if (goal.ok) {
    value.standGoalMinutes = goal.value;
  } else if (windowMinutes !== null && Number.isInteger(asNumber(merged.standGoalMinutes))) {
    errors.push({
      field: 'standGoalMinutes',
      message: `The standing goal must fit inside the working day (at most ${windowMinutes} minutes).`,
    });
  } else {
    errors.push({ field: 'standGoalMinutes', message: goal.message });
  }

  for (const [field, label] of [
    ['sitNudgeMinutes', 'The sitting nudge'],
    ['standNudgeMinutes', 'The standing nudge'],
  ]) {
    const nudge = checkMinutes(merged[field], label, MAX_NUDGE_MINUTES);
    if (nudge.ok) value[field] = nudge.value;
    else errors.push({ field, message: nudge.message });
  }

  const threshold = checkMinutes(
    merged.implausibleAfterMinutes,
    'The "looks too long" threshold',
    MINUTES_IN_DAY,
    MIN_IMPLAUSIBLE_MINUTES,
  );
  if (threshold.ok) value.implausibleAfterMinutes = threshold.value;
  else errors.push({ field: 'implausibleAfterMinutes', message: threshold.message });

  if (typeof merged.autoStopAtWorkEnd === 'boolean') {
    value.autoStopAtWorkEnd = merged.autoStopAtWorkEnd;
  } else if (merged.autoStopAtWorkEnd === 'true' || merged.autoStopAtWorkEnd === 'false') {
    value.autoStopAtWorkEnd = merged.autoStopAtWorkEnd === 'true';
  } else {
    errors.push({
      field: 'autoStopAtWorkEnd',
      message: 'Stopping at the end of the day is either on or off.',
    });
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, value };
}

function pickKnown(source) {
  const picked = {};
  if (!source || typeof source !== 'object') return picked;
  for (const key of SETTING_KEYS) {
    if (key in source) picked[key] = source[key];
  }
  return picked;
}

/**
 * Build settings from stored `{key, value}` rows, where each value is JSON.
 *
 * Stored values are never trusted. Anything unparseable, unknown or invalid
 * is dropped and the default takes over, so a hand-edited or half-migrated
 * database still yields a usable configuration instead of an error.
 */
export function parseSettings(rows) {
  const stored = {};
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!SETTING_KEYS.includes(row?.key)) continue;
    try {
      stored[row.key] = JSON.parse(row.value);
    } catch {
      // Leave the key absent; the default is used below.
    }
  }

  // Drop offending fields and retry, so one bad value cannot discard the rest.
  let candidate = stored;
  for (let attempt = 0; attempt <= SETTING_KEYS.length; attempt += 1) {
    const result = validateSettings(candidate, DEFAULT_SETTINGS);
    if (result.ok) return result.value;

    const remaining = { ...candidate };
    for (const { field } of result.errors) delete remaining[field];
    candidate = remaining;
  }
  return freshDefaults();
}

/** Settings as `{key, value}` rows ready to be written to the database. */
export function serializeSettings(settings) {
  return SETTING_KEYS.map((key) => ({ key, value: JSON.stringify(settings[key]) }));
}

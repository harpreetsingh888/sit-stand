import test from 'node:test';
import assert from 'node:assert/strict';

import {
  localDayKey,
  dayRange,
  dayKeysBetween,
  workWindowForDayKey,
  sessionContributions,
  aggregateDaily,
  goalProgress,
  shiftDayKey,
} from '../lib/stats.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

// A known week in 2026: the 7th is a Monday, the 11th a Friday,
// the 12th/13th the weekend, the 14th the following Monday.
const MON = '2026-09-07';
const TUE = '2026-09-08';
const FRI = '2026-09-11';
const SAT = '2026-09-12';
const SUN = '2026-09-13';
const NEXT_MON = '2026-09-14';

const WORK = {
  workStart: '09:00',
  workEnd: '17:00',
  workDays: [1, 2, 3, 4, 5],
  standGoalMinutes: 120,
  sitNudgeMinutes: 50,
  standNudgeMinutes: 20,
};

/** Local wall-clock time on a given day, as epoch milliseconds. */
function at(dayKey, hhmm) {
  const [y, m, d] = dayKey.split('-').map(Number);
  const [hh, mi] = hhmm.split(':').map(Number);
  return new Date(y, m - 1, d, hh, mi, 0, 0).getTime();
}

const sit = (start, end) => ({ posture: 'sit', started_at: start, ended_at: end });
const away = (start, end) => ({ posture: 'away', started_at: start, ended_at: end });
const stand = (start, end) => ({ posture: 'stand', started_at: start, ended_at: end });

test('localDayKey names the local calendar day', () => {
  assert.equal(localDayKey(at(MON, '00:00')), MON);
  assert.equal(localDayKey(at(MON, '23:59')), MON);
  assert.equal(localDayKey(at(MON, '12:00') + 12 * HOUR), TUE);
});

test('dayRange spans local midnight to midnight', () => {
  const { start, end } = dayRange(MON);
  assert.equal(start, at(MON, '00:00'));
  assert.equal(end, at(TUE, '00:00'));
});

test('dayKeysBetween is inclusive and consecutive', () => {
  assert.deepEqual(dayKeysBetween(FRI, NEXT_MON), [FRI, SAT, SUN, NEXT_MON]);
  assert.deepEqual(dayKeysBetween(MON, MON), [MON]);
});

test('workWindowForDayKey returns the window on work days and null otherwise', () => {
  assert.deepEqual(workWindowForDayKey(MON, WORK), {
    start: at(MON, '09:00'),
    end: at(MON, '17:00'),
  });
  assert.equal(workWindowForDayKey(SAT, WORK), null);
  assert.equal(workWindowForDayKey(SUN, WORK), null);
});

test('a session wholly inside work hours counts in full', () => {
  const s = sit(at(MON, '10:00'), at(MON, '11:30'));
  assert.deepEqual(sessionContributions(s, WORK, { now: at(MON, '12:00') }), [
    { day: MON, posture: 'sit', ms: 90 * MINUTE },
  ]);
});

test('a session overhanging both ends is clipped to the work window', () => {
  const s = sit(at(MON, '07:00'), at(MON, '19:00'));
  const [only] = sessionContributions(s, WORK, { now: at(MON, '20:00') });
  assert.equal(only.ms, 8 * HOUR);
});

test('a session entirely outside work hours contributes nothing', () => {
  const s = stand(at(MON, '19:00'), at(MON, '21:00'));
  assert.deepEqual(sessionContributions(s, WORK, { now: at(TUE, '09:00') }), []);
});

test('a session on a non-work day contributes nothing', () => {
  const s = stand(at(SAT, '10:00'), at(SAT, '12:00'));
  assert.deepEqual(sessionContributions(s, WORK, { now: at(SUN, '09:00') }), []);
});

test('a session spanning midnight splits across two days', () => {
  const s = sit(at(MON, '16:00'), at(TUE, '10:00'));
  assert.deepEqual(sessionContributions(s, WORK, { now: at(TUE, '12:00') }), [
    { day: MON, posture: 'sit', ms: 1 * HOUR },
    { day: TUE, posture: 'sit', ms: 1 * HOUR },
  ]);
});

test('a session spanning a weekend skips the non-work days', () => {
  const s = sit(at(FRI, '16:00'), at(NEXT_MON, '10:00'));
  assert.deepEqual(sessionContributions(s, WORK, { now: at(NEXT_MON, '12:00') }), [
    { day: FRI, posture: 'sit', ms: 1 * HOUR },
    { day: NEXT_MON, posture: 'sit', ms: 1 * HOUR },
  ]);
});

test('an open session is clipped to now', () => {
  const s = stand(at(MON, '10:00'), null);
  assert.deepEqual(sessionContributions(s, WORK, { now: at(MON, '10:45') }), [
    { day: MON, posture: 'stand', ms: 45 * MINUTE },
  ]);
});

test('an open session left running past work hours stops at the work window', () => {
  const s = sit(at(MON, '16:00'), null);
  const [only] = sessionContributions(s, WORK, { now: at(TUE, '08:00') });
  assert.equal(only.day, MON);
  assert.equal(only.ms, 1 * HOUR);
});

test('zero-length and reversed sessions contribute nothing', () => {
  const now = at(MON, '15:00');
  assert.deepEqual(sessionContributions(sit(at(MON, '10:00'), at(MON, '10:00')), WORK, { now }), []);
  assert.deepEqual(sessionContributions(sit(at(MON, '12:00'), at(MON, '10:00')), WORK, { now }), []);
});

test('malformed sessions contribute nothing rather than throwing', () => {
  const now = at(MON, '15:00');
  assert.deepEqual(sessionContributions({ posture: 'sit', started_at: null, ended_at: null }, WORK, { now }), []);
  assert.deepEqual(sessionContributions({ posture: 'sit', started_at: NaN, ended_at: 5 }, WORK, { now }), []);
});

test('an open session starting in the future contributes nothing', () => {
  const s = sit(at(MON, '14:00'), null);
  assert.deepEqual(sessionContributions(s, WORK, { now: at(MON, '13:00') }), []);
});

test('contributions are limited to the requested range', () => {
  const s = sit(at(MON, '09:00'), at(TUE, '17:00'));
  const contributions = sessionContributions(s, WORK, {
    now: at(TUE, '18:00'),
    rangeStart: dayRange(TUE).start,
    rangeEnd: dayRange(TUE).end,
  });
  assert.deepEqual(contributions, [{ day: TUE, posture: 'sit', ms: 8 * HOUR }]);
});

test('a work window spanning a daylight-saving jump measures real elapsed time', () => {
  // Europe/London springs forward at 01:00 on 2026-03-29; 01:00-02:00 never
  // happens, so a 00:00-09:00 wall-clock window is only eight real hours.
  assert.equal(process.env.TZ, 'Europe/London', 'run this suite with TZ=Europe/London');
  const springForward = '2026-03-29'; // a Sunday
  const settings = { ...WORK, workStart: '00:00', workEnd: '09:00', workDays: [0] };
  const s = sit(at(springForward, '00:00'), at(springForward, '09:00'));
  const [only] = sessionContributions(s, settings, { now: at('2026-03-30', '12:00') });
  assert.equal(only.ms, 8 * HOUR);
});

test('day stepping stays consecutive across a daylight-saving jump', () => {
  assert.deepEqual(dayKeysBetween('2026-03-28', '2026-03-30'), [
    '2026-03-28',
    '2026-03-29',
    '2026-03-30',
  ]);
});

test('aggregateDaily totals each posture and fills empty days', () => {
  const sessions = [
    sit(at(MON, '09:00'), at(MON, '11:00')),
    stand(at(MON, '11:00'), at(MON, '12:00')),
    sit(at(MON, '12:00'), at(MON, '13:00')),
    stand(at(SAT, '10:00'), at(SAT, '12:00')),
    sit(at(TUE, '09:30'), at(TUE, '10:00')),
  ];
  const days = aggregateDaily(sessions, WORK, {
    now: at(TUE, '18:00'),
    fromDayKey: MON,
    toDayKey: TUE,
  });
  assert.deepEqual(days, [
    { day: MON, isWorkDay: true, sit: 3 * HOUR, stand: 1 * HOUR, away: 0 },
    { day: TUE, isWorkDay: true, sit: 30 * MINUTE, stand: 0, away: 0 },
  ]);
});

test('aggregateDaily marks non-work days and reports them as empty', () => {
  const days = aggregateDaily([], WORK, {
    now: at(NEXT_MON, '12:00'),
    fromDayKey: FRI,
    toDayKey: SUN,
  });
  assert.deepEqual(days.map((d) => [d.day, d.isWorkDay]), [
    [FRI, true],
    [SAT, false],
    [SUN, false],
  ]);
  assert.ok(days.every((d) => d.sit === 0 && d.stand === 0));
});

test('goalProgress reports remaining time and clamps the ratio', () => {
  const partial = goalProgress(30 * MINUTE, WORK);
  assert.equal(partial.goalMs, 120 * MINUTE);
  assert.equal(partial.ratio, 0.25);
  assert.equal(partial.remainingMs, 90 * MINUTE);
  assert.equal(partial.met, false);

  const over = goalProgress(180 * MINUTE, WORK);
  assert.equal(over.ratio, 1);
  assert.equal(over.remainingMs, 0);
  assert.equal(over.met, true);
});

test('shiftDayKey moves whole days and survives a daylight-saving change', () => {
  assert.equal(shiftDayKey(MON, 1), TUE);
  assert.equal(shiftDayKey(NEXT_MON, -3), FRI);
  assert.equal(shiftDayKey(MON, 0), MON);
  assert.equal(shiftDayKey('2026-03-28', 2), '2026-03-30');
  assert.equal(shiftDayKey('2026-01-01', -1), '2025-12-31');
});

test('away is clipped to working hours like any other posture', () => {
  const s = away(at(MON, '12:00'), at(MON, '13:00'));
  assert.deepEqual(sessionContributions(s, WORK, { now: at(MON, '14:00') }), [
    { day: MON, posture: 'away', ms: 1 * HOUR },
  ]);

  const overnight = away(at(MON, '16:30'), at(TUE, '09:30'));
  assert.deepEqual(sessionContributions(overnight, WORK, { now: at(TUE, '10:00') }), [
    { day: MON, posture: 'away', ms: 30 * MINUTE },
    { day: TUE, posture: 'away', ms: 30 * MINUTE },
  ]);
});

test('a posture that is not sit, stand or away still contributes nothing', () => {
  const s = { posture: 'lying', started_at: at(MON, '10:00'), ended_at: at(MON, '11:00') };
  assert.deepEqual(sessionContributions(s, WORK, { now: at(MON, '12:00') }), []);
});

test('aggregateDaily totals away alongside sitting and standing', () => {
  const sessions = [
    sit(at(MON, '09:00'), at(MON, '11:00')),
    away(at(MON, '11:00'), at(MON, '12:00')),
    stand(at(MON, '12:00'), at(MON, '13:00')),
  ];
  const [monday] = aggregateDaily(sessions, WORK, {
    now: at(MON, '18:00'),
    fromDayKey: MON,
    toDayKey: MON,
  });
  assert.deepEqual(monday, {
    day: MON,
    isWorkDay: true,
    sit: 2 * HOUR,
    stand: 1 * HOUR,
    away: 1 * HOUR,
  });
});

test('every day reports an away total, even an empty one', () => {
  const days = aggregateDaily([], WORK, { now: at(TUE, '12:00'), fromDayKey: MON, toDayKey: TUE });
  assert.ok(days.every((day) => day.away === 0));
});

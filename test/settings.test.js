import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_SETTINGS,
  parseSettings,
  serializeSettings,
  validateSettings,
} from '../lib/settings.js';

const errorFields = (result) => result.errors.map((e) => e.field).sort();

test('defaults describe a normal weekday office day', () => {
  assert.equal(DEFAULT_SETTINGS.workStart, '09:00');
  assert.equal(DEFAULT_SETTINGS.workEnd, '18:00');
  assert.deepEqual(DEFAULT_SETTINGS.workDays, [1, 2, 3, 4, 5]);
  assert.ok(validateSettings(DEFAULT_SETTINGS, DEFAULT_SETTINGS).ok);
});

test('defaults are frozen, so a caller cannot corrupt them', () => {
  assert.throws(() => {
    DEFAULT_SETTINGS.workStart = '07:00';
  }, TypeError);
  assert.throws(() => {
    DEFAULT_SETTINGS.workDays.push(6);
  }, TypeError);
  assert.deepEqual(parseSettings([]).workDays, [1, 2, 3, 4, 5]);
});

test('parseSettings falls back to defaults when nothing is stored', () => {
  assert.deepEqual(parseSettings([]), DEFAULT_SETTINGS);
  assert.deepEqual(parseSettings(null), DEFAULT_SETTINGS);
});

test('parseSettings applies stored values over the defaults', () => {
  const settings = parseSettings([
    { key: 'workStart', value: '"08:30"' },
    { key: 'standGoalMinutes', value: '90' },
  ]);
  assert.equal(settings.workStart, '08:30');
  assert.equal(settings.standGoalMinutes, 90);
  assert.equal(settings.workEnd, DEFAULT_SETTINGS.workEnd);
});

test('parseSettings ignores corrupt or invalid stored values', () => {
  const settings = parseSettings([
    { key: 'workStart', value: 'not json' },
    { key: 'workEnd', value: '"25:00"' },
    { key: 'workDays', value: '"everyday"' },
    { key: 'sitNudgeMinutes', value: '-4' },
    { key: 'unknownKey', value: '1' },
  ]);
  assert.deepEqual(settings, DEFAULT_SETTINGS);
  assert.equal('unknownKey' in settings, false);
});

test('serializeSettings round-trips through parseSettings', () => {
  const original = { ...DEFAULT_SETTINGS, workStart: '07:45', workDays: [1, 3, 5] };
  assert.deepEqual(parseSettings(serializeSettings(original)), original);
});

test('validateSettings merges a partial patch onto the current settings', () => {
  const result = validateSettings({ standGoalMinutes: 45 }, DEFAULT_SETTINGS);
  assert.ok(result.ok);
  assert.equal(result.value.standGoalMinutes, 45);
  assert.equal(result.value.workStart, DEFAULT_SETTINGS.workStart);
});

test('validateSettings ignores unknown keys', () => {
  const result = validateSettings({ nope: 1, workStart: '08:00' }, DEFAULT_SETTINGS);
  assert.ok(result.ok);
  assert.equal('nope' in result.value, false);
});

test('validateSettings rejects a work window that does not move forward', () => {
  for (const patch of [{ workEnd: '09:00' }, { workEnd: '08:00' }]) {
    const result = validateSettings(patch, DEFAULT_SETTINGS);
    assert.equal(result.ok, false);
    assert.deepEqual(errorFields(result), ['workEnd']);
    assert.match(result.errors[0].message, /after/i);
  }
});

test('validateSettings rejects malformed times', () => {
  for (const bad of ['9:00', '25:00', '09:60', '', 'noon', 900]) {
    const result = validateSettings({ workStart: bad }, DEFAULT_SETTINGS);
    assert.equal(result.ok, false, `expected ${JSON.stringify(bad)} to be rejected`);
    assert.ok(result.errors.some((e) => e.field === 'workStart'));
  }
});

test('validateSettings rejects unusable work day lists', () => {
  for (const bad of [[], [7], [-1], ['mon'], 'monday', [1.5]]) {
    const result = validateSettings({ workDays: bad }, DEFAULT_SETTINGS);
    assert.equal(result.ok, false, `expected ${JSON.stringify(bad)} to be rejected`);
    assert.ok(result.errors.some((e) => e.field === 'workDays'));
  }
});

test('validateSettings sorts and de-duplicates work days', () => {
  const result = validateSettings({ workDays: [5, 1, 1, 0] }, DEFAULT_SETTINGS);
  assert.ok(result.ok);
  assert.deepEqual(result.value.workDays, [0, 1, 5]);
});

test('validateSettings keeps the standing goal within the working day', () => {
  const nineToFive = { ...DEFAULT_SETTINGS, workEnd: '17:00' };

  assert.ok(validateSettings({ standGoalMinutes: 480 }, nineToFive).ok);

  const tooBig = validateSettings({ standGoalMinutes: 481 }, nineToFive);
  assert.equal(tooBig.ok, false);
  assert.deepEqual(errorFields(tooBig), ['standGoalMinutes']);
  assert.match(tooBig.errors[0].message, /working day|work window|480/i);
});

test('validateSettings checks the goal against the window in the same patch', () => {
  const result = validateSettings(
    { workStart: '09:00', workEnd: '10:00', standGoalMinutes: 120 },
    DEFAULT_SETTINGS,
  );
  assert.equal(result.ok, false);
  assert.deepEqual(errorFields(result), ['standGoalMinutes']);
});

test('validateSettings rejects unusable nudge thresholds', () => {
  for (const field of ['sitNudgeMinutes', 'standNudgeMinutes']) {
    for (const bad of [0, -5, 1.5, 481, 'soon', null]) {
      const result = validateSettings({ [field]: bad }, DEFAULT_SETTINGS);
      assert.equal(result.ok, false, `expected ${field}=${JSON.stringify(bad)} to be rejected`);
      assert.ok(result.errors.some((e) => e.field === field));
    }
  }
});

test('validateSettings accepts numeric strings from form input', () => {
  const result = validateSettings({ standGoalMinutes: '90', sitNudgeMinutes: '45' }, DEFAULT_SETTINGS);
  assert.ok(result.ok);
  assert.equal(result.value.standGoalMinutes, 90);
  assert.equal(result.value.sitNudgeMinutes, 45);
});

test('validateSettings reports every bad field at once', () => {
  const result = validateSettings(
    { workStart: 'nope', workDays: [], sitNudgeMinutes: 0 },
    DEFAULT_SETTINGS,
  );
  assert.equal(result.ok, false);
  assert.deepEqual(errorFields(result), ['sitNudgeMinutes', 'workDays', 'workStart']);
});

test('validateSettings does not mutate the settings it is given', () => {
  const current = { ...DEFAULT_SETTINGS, workDays: [1, 2] };
  const snapshot = structuredClone(current);
  validateSettings({ workDays: [3, 4], workStart: '07:00' }, current);
  assert.deepEqual(current, snapshot);
});

test('a threshold decides when a session looks too long to be real', () => {
  assert.equal(DEFAULT_SETTINGS.implausibleAfterMinutes, 180);

  const result = validateSettings({ implausibleAfterMinutes: 240 }, DEFAULT_SETTINGS);
  assert.ok(result.ok);
  assert.equal(result.value.implausibleAfterMinutes, 240);
});

test('the implausibility threshold has to be a sensible stretch of time', () => {
  for (const bad of [0, 29, 1441, -10, 2.5, 'ages', null]) {
    const result = validateSettings({ implausibleAfterMinutes: bad }, DEFAULT_SETTINGS);
    assert.equal(result.ok, false, `expected ${JSON.stringify(bad)} to be rejected`);
    assert.ok(result.errors.some((e) => e.field === 'implausibleAfterMinutes'));
  }
  assert.ok(validateSettings({ implausibleAfterMinutes: 30 }, DEFAULT_SETTINGS).ok);
  assert.ok(validateSettings({ implausibleAfterMinutes: 1440 }, DEFAULT_SETTINGS).ok);
});

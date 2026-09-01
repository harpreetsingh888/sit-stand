import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyAction } from '../lib/sync.js';

const HOUR = 3_600_000;
const T9 = Date.UTC(2026, 8, 7, 9, 0, 0);
const at = (hours) => T9 + hours * HOUR;

// A morning already recorded on the desktop: sitting 9-11, standing 11 to now.
const RECORDED = [
  { id: 1, posture: 'sit', started_at: at(0), ended_at: at(2) },
  { id: 2, posture: 'stand', started_at: at(2), ended_at: null },
];

test('an action landing in a gap is simply applied', () => {
  const gapped = [{ id: 1, posture: 'sit', started_at: at(0), ended_at: at(1) }];
  const result = classifyAction({ posture: 'away', at: at(1.5) }, gapped);

  assert.equal(result.kind, 'apply');
});

test('an action repeating what is already recorded is dropped', () => {
  const result = classifyAction({ posture: 'sit', at: at(1) }, RECORDED);
  assert.equal(result.kind, 'noop');
});

test('a late switch inside the block still running is applied', () => {
  // The phone says "I went away at 11:30"; standing is still open, so this is
  // exactly the late report the timestamp exists for.
  const result = classifyAction({ posture: 'away', at: at(2.5) }, RECORDED);
  assert.equal(result.kind, 'apply');
});

test('an action contradicting a finished block is a conflict', () => {
  // The phone says "away at 10:00", but the desktop has already closed off a
  // sitting block covering that time. The desktop's record is the one on file.
  const result = classifyAction({ posture: 'away', at: at(1) }, RECORDED);

  assert.equal(result.kind, 'conflict');
  assert.equal(result.existing.id, 1);
  assert.equal(result.existing.posture, 'sit');
});

test('an action before anything was recorded is applied', () => {
  const result = classifyAction({ posture: 'sit', at: at(-1) }, RECORDED);
  assert.equal(result.kind, 'apply');
});

test('an action dated into an empty history is applied', () => {
  assert.equal(classifyAction({ posture: 'sit', at: at(1) }, []).kind, 'apply');
});

test('a malformed action is rejected rather than guessed at', () => {
  for (const bad of [
    { posture: 'flying', at: at(1) },
    { posture: 'sit', at: 'noon' },
    { posture: 'sit' },
    {},
    null,
  ]) {
    assert.equal(classifyAction(bad, RECORDED).kind, 'invalid', JSON.stringify(bad));
  }
});

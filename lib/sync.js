/**
 * Reconciling actions a phone recorded while it had no connection.
 *
 * The desktop runs the server and writes to it directly, so whatever is
 * already stored is the desktop's account of the day. A queued action arriving
 * late never overwrites that quietly: if the two disagree, the stored record
 * stands and the disagreement is put to the person to settle.
 */

import { isPosture } from './postures.js';

/** The block covering a moment, or null if that moment falls in a gap. */
function sessionCovering(sessions, when) {
  return (
    sessions.find(
      (session) =>
        session.started_at <= when && (session.ended_at === null || session.ended_at > when),
    ) ?? null
  );
}

/**
 * Decide what to do with one queued action.
 *
 * - `invalid`  the action is not usable
 * - `noop`     it agrees with what is recorded; nothing to do
 * - `apply`    it fits without contradicting anything
 * - `conflict` it contradicts a block the desktop has already closed
 */
export function classifyAction(action, sessions) {
  if (!action || !isPosture(action.posture) || !Number.isFinite(action.at)) {
    return { kind: 'invalid' };
  }

  const covering = sessionCovering(sessions ?? [], action.at);
  if (!covering) return { kind: 'apply' };
  if (covering.posture === action.posture) return { kind: 'noop' };

  // Still running: the day has not moved past this moment, so a late report is
  // just a late report rather than a contradiction.
  if (covering.ended_at === null) return { kind: 'apply' };

  return { kind: 'conflict', existing: covering };
}

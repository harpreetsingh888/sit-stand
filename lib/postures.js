/**
 * The postures the tracker knows about, shared by the storage layer, the
 * statistics and the API so there is exactly one list to extend.
 *
 * `away` is a real, timed posture rather than an absence of one: it is stored,
 * clipped to working hours and totalled exactly like sitting and standing.
 * Stopping tracking altogether is a separate thing, and records nothing.
 */

export const POSTURES = Object.freeze(['sit', 'stand', 'away']);

export const isPosture = (value) => POSTURES.includes(value);

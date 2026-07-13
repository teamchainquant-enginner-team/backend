/**
 * Normalized data envelope.
 *
 * Nothing leaves a service without one. This is the structural guarantee behind
 * the data-integrity rule: the UI cannot render a number without also receiving
 * what it is (live / estimated / model output / demo / unavailable), where it
 * came from, and when it was fetched. Honesty is enforced by the shape of the
 * data, not by a promise in a code review.
 */
export const STATUS = {
  LIVE: 'live',
  DELAYED: 'delayed',
  ESTIMATED: 'estimated',
  MODEL: 'model',
  DEMO: 'demo',
  UNAVAILABLE: 'unavailable',
};

export function envelope(value, { status, source, fetched_at, model_version = null, note = null } = {}) {
  if (!Object.values(STATUS).includes(status)) throw new Error(`envelope(): invalid status "${status}"`);
  return { value, status, source, fetched_at: fetched_at || new Date().toISOString(), model_version, note };
}

/** A first-class "we do not have this" — used instead of inventing a value. */
export function unavailable(source, note) {
  return envelope(null, { status: STATUS.UNAVAILABLE, source, note });
}

/** Anything served from the Supabase cache is DELAYED, not LIVE. Say so. */
export function delayed(value, source, fetched_at, note) {
  return envelope(value, { status: STATUS.DELAYED, source, fetched_at, note });
}

/**
 * Whether a newly computed list may replace the last accepted one.
 *
 * A list is implausible when there is no last accepted list and it is below
 * `floor`, or when it is more than `maxDropRatio` smaller than the last accepted
 * one (an empty list is such a drop). An implausible list is refused until every
 * result for `confirmMs` has been implausible, and is then accepted; one
 * plausible result clears the pending wait. A registry mid-rebuild answers for
 * tens of seconds, so it never outlasts the confirmation; a genuine change does.
 *
 * @param {number} count size of the candidate list
 * @param {{ lastAcceptedCount: (number|null), pendingSince: (number|null) }} state
 * @param {{ floor: number, maxDropRatio: number, confirmMs: number }} limits
 * @param {number} now milliseconds, any monotonic clock
 * @returns {{
 *   accept: boolean,
 *   reason: ('below-floor'|'drop'|'confirmed'|null),
 *   state: { lastAcceptedCount: (number|null), pendingSince: (number|null) },
 * }}
 */
function evaluateListChange(count, state, limits, now) {
  const { lastAcceptedCount, pendingSince } = state;

  const implausible = lastAcceptedCount === null
    ? count < limits.floor
    : lastAcceptedCount - count > lastAcceptedCount * limits.maxDropRatio;

  if (!implausible) {
    return { accept: true, reason: null, state: { lastAcceptedCount: count, pendingSince: null } };
  }

  const since = pendingSince ?? now;
  if (now - since < limits.confirmMs) {
    const reason = lastAcceptedCount === null ? 'below-floor' : 'drop';
    return { accept: false, reason, state: { lastAcceptedCount, pendingSince: since } };
  }
  return { accept: true, reason: 'confirmed', state: { lastAcceptedCount: count, pendingSince: null } };
}

module.exports = {
  evaluateListChange,
};

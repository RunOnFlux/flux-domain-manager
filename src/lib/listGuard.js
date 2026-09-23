/**
 * Whether a newly computed list may replace the last accepted one.
 *
 * An empty list is always refused. The first list, with nothing to compare it to,
 * must reach `floor`. After that, a list more than `maxDropRatio` smaller than the
 * last accepted one is refused until every result for `confirmMs` has been that
 * much smaller; one result within the ratio clears the pending drop. A registry
 * mid-rebuild answers for tens of seconds, so it never outlasts the confirmation;
 * a genuine shrink does, and is then accepted.
 *
 * @param {number} count size of the candidate list
 * @param {{ lastAcceptedCount: (number|null), dropSince: (number|null) }} state
 * @param {{ floor: number, maxDropRatio: number, confirmMs: number }} limits
 * @param {number} now milliseconds, any monotonic clock
 * @returns {{
 *   accept: boolean,
 *   reason: ('empty'|'below-floor'|'drop'|'confirmed-drop'|null),
 *   state: { lastAcceptedCount: (number|null), dropSince: (number|null) },
 * }}
 */
function evaluateListChange(count, state, limits, now) {
  const { lastAcceptedCount, dropSince } = state;

  if (count === 0) return { accept: false, reason: 'empty', state };

  if (lastAcceptedCount === null) {
    if (count < limits.floor) return { accept: false, reason: 'below-floor', state };
    return { accept: true, reason: null, state: { lastAcceptedCount: count, dropSince: null } };
  }

  const drop = lastAcceptedCount - count;
  if (drop > lastAcceptedCount * limits.maxDropRatio) {
    const since = dropSince ?? now;
    if (now - since < limits.confirmMs) {
      return { accept: false, reason: 'drop', state: { lastAcceptedCount, dropSince: since } };
    }
    return { accept: true, reason: 'confirmed-drop', state: { lastAcceptedCount: count, dropSince: null } };
  }

  return { accept: true, reason: null, state: { lastAcceptedCount: count, dropSince: null } };
}

function initialListState() {
  return { lastAcceptedCount: null, dropSince: null };
}

module.exports = {
  evaluateListChange,
  initialListState,
};

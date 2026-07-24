// When one of the two routing loops (active-active / active-standby) finishes building
// its route configs, this decides what happens to them. The two loops are symmetric —
// each publishes the concatenation of both sides' configs and remembers its own — so the
// policy lives here once rather than twice, and can be tested without standing up a
// routing loop.
//
// The remembered configs do two jobs at once, which is what makes the ordering subtle:
//
//   change detection — a cycle that rebuilds identical configs skips the reload;
//   cross-loop handoff — each loop reads the OTHER loop's remembered configs to
//                        assemble the combined config it publishes.
//
// So the memo cannot simply be advanced last. If a loop withheld it while waiting for
// its counterpart, the counterpart would hit the mirror-image wait and neither would
// ever publish. It also cannot be advanced first: a config haproxy rejects would be
// remembered as published, and the next cycle would rebuild the same configs, match the
// memo, and skip — leaving the fleet frozen on the last good config until the app set
// happened to change. Advancing it on the deferred path but only after a successful
// publish satisfies both.

/**
 * Decide and carry out the publication of one loop's freshly built route configs.
 *
 * Throws whatever `update` throws — the caller assigns the returned `remember` value, so
 * a failed publish leaves the previous memo in place and the next cycle retries.
 *
 * @param {Object} args
 * @param {Array} args.next route configs this cycle just built
 * @param {Array} args.remembered route configs this loop published (or deferred) last
 * @param {Array} args.counterpart the other loop's remembered route configs
 * @param {boolean} args.counterpartFirst whether the other loop's configs lead the
 *   combined config; active-active always leads, so active-standby passes true
 * @param {Function} args.update publishes the combined configs (rejects if haproxy won't take them)
 * @param {Function} [args.onChanged] called once the configs are known to differ, before
 *   the deferred decision
 * @param {Function} [args.onPublish] called with the combined configs immediately before
 *   publishing, so the caller keeps its "about to reload" logging ahead of the reload
 * @returns {Promise<{action: 'unchanged'|'deferred'|'published', remember: Array, combined: (Array|null)}>}
 */
async function publishRouteConfigs({
  next, remembered, counterpart, counterpartFirst, update,
  onChanged = () => {}, onPublish = () => {},
}) {
  if (JSON.stringify(next) === JSON.stringify(remembered)) {
    return { action: 'unchanged', remember: remembered, combined: null };
  }
  onChanged();

  // The counterpart has not completed a cycle yet, so there is nothing to combine with.
  // Remember these anyway — that record is exactly what lets the counterpart proceed.
  if (!counterpart.length) {
    return { action: 'deferred', remember: next, combined: null };
  }

  const combined = counterpartFirst ? counterpart.concat(next) : next.concat(counterpart);
  onPublish(combined);
  await update(combined);
  return { action: 'published', remember: next, combined };
}

/**
 * A loop's whole end-of-cycle: ask the guard whether what was built is complete enough,
 * and publish it if so.
 *
 * The order is the point. The guard runs BEFORE anything is published and before the memo
 * moves, so a withheld cycle changes nothing at all: haproxy keeps serving, the loop keeps
 * the configs it last published, and the next cycle rebuilds from scratch and asks again.
 * Returning the previous memo as `remember` on the withheld path is what makes the caller
 * assigning it unconditionally safe.
 *
 * @param {Object} args
 * @param {{allows: Function}} args.guard this loop's PublishGuard
 * @param {Array} args.next route configs this cycle just built
 * @param {Array} args.remembered route configs this loop published (or deferred) last
 * @param {...} rest as publishRouteConfigs
 * @returns {Promise<{action: 'withheld'|'unchanged'|'deferred'|'published', remember: Array, combined: (Array|null)}>}
 */
async function runPublishCycle({
  guard, next, remembered, counterpart, counterpartFirst, update,
  onChanged = () => {}, onPublish = () => {},
}) {
  if (!guard.allows(next.length)) {
    return { action: 'withheld', remember: remembered, combined: null };
  }
  const outcome = await publishRouteConfigs({
    next, remembered, counterpart, counterpartFirst, update, onChanged, onPublish,
  });
  return outcome;
}

module.exports = { publishRouteConfigs, runPublishCycle };

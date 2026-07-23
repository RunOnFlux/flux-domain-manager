// Whether a freshly built set of route configs is complete enough to publish.
//
// A cycle that produced far fewer routes than the last good one has almost certainly built
// them from an incomplete view of the network, not from a network that genuinely shrank —
// publishing it would drop hundreds of apps from routing at once. Withholding leaves
// haproxy serving the last good config, which is the safe failure.
//
// This replaces asking whether one named app looks healthy. App health is a property of
// that app and its host nodes; completeness is a property of the fetch. Using the first to
// infer the second failed both ways: an app legitimately going to zero froze routing for
// everything, while a payload missing half the apps published fine as long as the named app
// happened to be in it.
//
// It cannot withhold forever. If the population really did shrink, the guard is simply
// wrong and would freeze routing permanently — so after a bounded number of consecutive
// withholds it publishes anyway and says it overrode itself. A guard that can be wrong
// forever is worse than no guard.

const log = require('../../lib/log');

/**
 * @param {Object} args
 * @param {number} args.count route configs this cycle built
 * @param {number|null} args.lastGoodCount count from the last cycle that published, or
 *   null before this process has published anything
 * @param {number} args.consecutiveWithholds how many cycles in a row have been withheld
 * @param {Object} args.limits
 * @param {number} args.limits.minRouteConfigs absolute floor, used only at cold start when
 *   there is no previous count to compare against
 * @param {number} args.limits.minRouteRetention fraction of the last good count this cycle
 *   must reach, e.g. 0.7
 * @param {number} args.limits.maxConsecutiveWithholds withholds allowed in a row before
 *   the guard defers to reality
 * @returns {{publish: boolean, reason: string|null, overridden: boolean, floor: number|null}}
 */
function assessRouteConfigs({
  count,
  lastGoodCount,
  consecutiveWithholds,
  limits,
}) {
  const {
    minRouteConfigs,
    minRouteRetention,
    maxConsecutiveWithholds,
  } = limits;

  // Cold start: nothing to compare against, so only the absolute floor applies.
  const coldStart = lastGoodCount === null || lastGoodCount === undefined;
  const floor = coldStart ? minRouteConfigs : Math.floor(lastGoodCount * minRouteRetention);
  const short = count < floor;

  if (!short) {
    return {
      publish: true, reason: null, overridden: false, floor,
    };
  }

  const reason = coldStart
    ? `only ${count} route configs on the first cycle, below the floor of ${floor}`
    : `${count} route configs, below ${floor} (${Math.round(minRouteRetention * 100)}% of the last good ${lastGoodCount})`;

  if (consecutiveWithholds >= maxConsecutiveWithholds) {
    return {
      publish: true,
      reason: `${reason} — publishing anyway after ${consecutiveWithholds} withheld cycles`,
      overridden: true,
      floor,
    };
  }

  return {
    publish: false, reason, overridden: false, floor,
  };
}

// One loop's guard: the pure decision above, plus the running state it needs (the size of
// the last config this loop published, and how many cycles in a row it has withheld) and
// the operator-facing logging. A withheld cycle has to be unmistakable in the log — it
// means routing changes have stopped being applied while haproxy carries on serving,
// which is otherwise indistinguishable from a quiet, healthy director.
class PublishGuard {
  #lastGoodCount = null;

  #consecutiveWithholds = 0;

  #label;

  #limits;

  #log;

  constructor(label, limits, logger = log) {
    this.#label = label;
    this.#limits = limits;
    this.#log = logger;
  }

  /**
   * @param {number} count route configs this cycle built
   * @returns {boolean} whether to go on and publish
   */
  allows(count) {
    const verdict = assessRouteConfigs({
      count,
      lastGoodCount: this.#lastGoodCount,
      consecutiveWithholds: this.#consecutiveWithholds,
      limits: this.#limits,
    });

    if (!verdict.publish) {
      this.#consecutiveWithholds += 1;
      this.#log.error(
        `${this.#label}: WITHHELD haproxy update — ${verdict.reason}. haproxy keeps serving `
        + 'the last published config, so routing changes are NOT being applied. '
        + `Withheld cycles in a row: ${this.#consecutiveWithholds}.`,
      );
      return false;
    }

    if (verdict.overridden) {
      this.#log.error(`${this.#label}: ${verdict.reason}. Treating the smaller config as the new truth.`);
    }
    this.#consecutiveWithholds = 0;
    this.#lastGoodCount = count;
    return true;
  }
}

module.exports = { assessRouteConfigs, PublishGuard };

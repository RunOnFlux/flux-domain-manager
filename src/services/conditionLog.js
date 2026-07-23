// Log a condition that persists across cycles, without repeating it every cycle.
//
// The routing loops run on every locations update, which the fetcher emits unconditionally
// every 10 seconds. Anything logged straight from a loop body while a condition holds is
// emitted ~8,600 times a day, per affected app — which buries the event it was meant to
// surface.
//
// So: log when the condition starts, log again periodically while it lasts (with how long
// it has been going, which is what an operator actually wants to know), and log when it
// clears. A lost start still surfaces at the next re-assertion rather than staying silent.
const log = require('../lib/log');

const DEFAULT_REASSERT_MS = 15 * 60 * 1000;

class ConditionLog {
  #since = new Map();

  #lastSaid = new Map();

  #reassertMs;

  #now;

  /**
   * @param {Object} [opts]
   * @param {number} [opts.reassertMs] how often to restate a condition that persists
   * @param {Function} [opts.now] clock, injectable for tests
   */
  constructor({ reassertMs = DEFAULT_REASSERT_MS, now = Date.now } = {}) {
    this.#reassertMs = reassertMs;
    this.#now = now;
  }

  /**
   * Report whether a condition currently holds. Logs only on the edges and on the
   * re-assertion interval.
   *
   * @param {string} key what the condition is about (an app name, a node address)
   * @param {boolean} active whether it holds right now
   * @param {Function} describe called with the duration in ms to build the message; only
   *   invoked when something is actually logged
   */
  report(key, active, describe) {
    const now = this.#now();

    if (!active) {
      if (this.#since.has(key)) {
        const heldMs = now - this.#since.get(key);
        this.#since.delete(key);
        this.#lastSaid.delete(key);
        log.info(`${describe(heldMs)} — cleared after ${ConditionLog.humanize(heldMs)}`);
      }
      return;
    }

    if (!this.#since.has(key)) {
      this.#since.set(key, now);
      this.#lastSaid.set(key, now);
      log.warn(describe(0));
      return;
    }

    if (now - this.#lastSaid.get(key) >= this.#reassertMs) {
      this.#lastSaid.set(key, now);
      const heldMs = now - this.#since.get(key);
      log.warn(`${describe(heldMs)} — ongoing for ${ConditionLog.humanize(heldMs)}`);
    }
  }

  /** Conditions currently held, for callers that want to report a total. */
  get activeCount() {
    return this.#since.size;
  }

  static humanize(ms) {
    const minutes = Math.round(ms / 60000);
    if (minutes < 1) return 'under a minute';
    if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
    const hours = Math.round(minutes / 6) / 10;
    return `${hours} hour${hours === 1 ? '' : 's'}`;
  }
}

module.exports = { ConditionLog };

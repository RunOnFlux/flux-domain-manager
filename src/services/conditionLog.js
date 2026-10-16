'use strict';

// Log a condition that persists across cycles, without repeating it every cycle.
//
// The routing loops run on every locations update, which the fetcher emits unconditionally
// every 10 seconds. Anything logged straight from a loop body while a condition holds is
// emitted ~8,600 times a day, per affected app — which buries the event it was meant to
// surface.
//
// So: log when the condition starts, and when it clears, with how long it lasted.
const log = require('../lib/log');

class ConditionLog {
  #since = new Map();

  #now;

  #level;

  /**
   * @param {Object} [opts]
   * @param {Function} [opts.now] clock, injectable for tests
   * @param {'error'|'warn'|'info'} [opts.level] the level a condition's start is logged at
   */
  constructor({ now = Date.now, level = 'warn' } = {}) {
    this.#now = now;
    this.#level = level;
  }

  /**
   * Report whether a condition currently holds. Logs only when it starts and when it
   * clears.
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
        log.info(`${describe(heldMs)} — cleared after ${ConditionLog.humanize(heldMs)}`);
      }
      return;
    }

    if (!this.#since.has(key)) {
      this.#since.set(key, now);
      log[this.#level](describe(0));
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

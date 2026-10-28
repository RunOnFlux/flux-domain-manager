const log = require('../../lib/log');

const TIMEOUT_PATTERN = /^(\d{1,10})(us|ms|s|m|h|d)?$/;
const MS_PER_UNIT = {
  us: 0.001, ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000,
};
// haproxy stores timeouts as signed 32-bit milliseconds and refuses a config
// holding a longer one.
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

/**
 * Whether haproxy accepts `value` as a timeout: a positive integer, optionally
 * with one of haproxy's time units, of 1 ms to 2^31-1 ms. A bare number is
 * milliseconds.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function isHaproxyTimeout(value) {
  const text = typeof value === 'number' ? String(value) : value;
  if (typeof text !== 'string') return false;
  const match = TIMEOUT_PATTERN.exec(text);
  if (!match) return false;
  const ms = Number(match[1]) * MS_PER_UNIT[match[2] || 'ms'];
  return ms >= 1 && ms <= MAX_TIMEOUT_MS;
}

const reportedRejections = new Set();

/**
 * The haproxy timeout a spec's environment parameters set with `timeout=`, or
 * null when they set none or set one haproxy would refuse, in which case the
 * backend keeps its default timeouts.
 *
 * @param {unknown} parameters a v1-3 `enviromentParameters` or a component's `environmentParameters`
 * @param {string} appName for the log line
 * @returns {string|null}
 */
function timeoutFromParameters(parameters, appName) {
  if (!Array.isArray(parameters)) return null;
  const parameter = parameters.find((p) => typeof p === 'string' && p.toLowerCase().startsWith('timeout='));
  if (!parameter) return null;
  const value = parameter.slice('timeout='.length).trim();
  if (isHaproxyTimeout(value)) return value;
  const key = `${appName}\u0000${parameter}`;
  if (!reportedRejections.has(key)) {
    reportedRejections.add(key);
    log.warn(`Ignoring ${JSON.stringify(parameter.slice(0, 300))} of ${appName}: not a valid haproxy timeout`);
  }
  return null;
}

module.exports = {
  isHaproxyTimeout,
  timeoutFromParameters,
};

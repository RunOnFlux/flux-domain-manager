/**
 * The largest app count any node reported within `windowMs`.
 *
 * A node whose registry is still being built answers with part of the app list.
 * Compared with the largest list seen recently, such a node stands out without
 * naming any app. The window lets a genuine shrink of the network become the
 * reference once the larger counts have aged out of it.
 *
 * @param {number} windowMs
 */
function createAppCountReference(windowMs) {
  let observations = [];

  return {
    /**
     * Records a count and returns the largest count within the window, this one included.
     *
     * @param {number} count
     * @param {number} now milliseconds, any monotonic clock
     * @returns {number}
     */
    observe(count, now) {
      observations = observations.filter((o) => now - o.at < windowMs);
      observations.push({ at: now, count });
      return observations.reduce((max, o) => Math.max(max, o.count), 0);
    },
  };
}

module.exports = {
  createAppCountReference,
};

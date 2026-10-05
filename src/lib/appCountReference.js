/**
 * The median of the latest app count each node reported within `windowMs`.
 *
 * A node whose registry is still being built answers with part of the app list,
 * and a node that is lagging or modified can answer with too many. Against the
 * median of the other nodes either stands out without naming any app, and no
 * single node can move the reference: each node holds one vote, its latest count.
 * A node not checked within the window loses its vote, so a genuine change in the
 * network becomes the reference as the nodes report it.
 *
 * The main balancer checks nodes one at a time, so the reference is built up
 * across checks. Once FluxOS serves `/apps/registrystatus`, the counts for a whole
 * pass can be fetched together and compared in one step, which replaces this
 * window and the warm-up in `hasManyApps`.
 *
 * @param {number} windowMs
 */
function createAppCountReference(windowMs) {
  const latest = new Map();

  return {
    /**
     * Records a node's count and returns the median over every node within the
     * window, this one included, with the number of nodes it was taken from.
     *
     * @param {string} node any stable key for the node, such as ip:port
     * @param {number} count
     * @param {number} now milliseconds, any monotonic clock
     * @returns {{ median: number, nodes: number }}
     */
    observe(node, count, now) {
      latest.forEach((o, key) => {
        if (now - o.at >= windowMs) latest.delete(key);
      });
      latest.set(node, { at: now, count });
      const counts = [...latest.values()].map((o) => o.count).sort((a, b) => a - b);
      const mid = Math.floor(counts.length / 2);
      const median = counts.length % 2 ? counts[mid] : (counts[mid - 1] + counts[mid]) / 2;
      return { median, nodes: counts.length };
    },
  };
}

module.exports = {
  createAppCountReference,
};

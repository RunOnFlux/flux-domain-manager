/**
 * Builds a synthetic g: app population shaped like the one measured on
 * fdm-eu-1-03 (subset O-U) on 2026-09-01:
 *
 *   336 g: apps in the pass
 *   308 resolved to an IP on the sticky, first probe
 *    28 resolved to NOTHING - every candidate answered 200 and simply was not
 *       running the component, which is a definitive answer FDM re-asks twice
 *   ~3 candidates per app (65 distinct retried IPs across the 28 failures)
 *
 * The 8.3% dead-ending share is what makes the pass what it is: those 28 apps
 * took 74% of the 479s.
 */
const DEAD_SHARE = 0.083;
const CANDIDATES_PER_APP = 3;

function mulberry32(seed) {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * @param {number} appCount how many g: apps
 * @param {number} nodeCount how many nodes in the fleet
 * @param {string} host fleet hostname
 * @param {number} portBase first node port
 */
function build(appCount, nodeCount, host, portBase, seed = 42) {
  const rnd = mulberry32(seed);
  const addr = (i) => `${host}:${portBase + i}`;

  const apps = [];
  const locations = new Map();
  const placements = {}; // node index -> { running: [], held: [] }
  const stickies = new Map();
  const place = (idx, key, name) => {
    if (!placements[idx]) placements[idx] = { running: [], held: [] };
    placements[idx][key].push(name);
  };

  const deadCount = Math.round(appCount * DEAD_SHARE);

  for (let a = 0; a < appCount; a += 1) {
    const name = `gapp${a}`;
    const dockerName = `fluxapp_${name}`;
    apps.push({
      version: 8,
      name,
      compose: [
        { name: 'app', containerData: 'g:/appdata', ports: [30000 + (a % 5000)] },
        { name: 'db', containerData: '/var/lib/db', ports: [31000 + (a % 5000)] },
      ],
    });

    // Candidate nodes: spread across the fleet, distinct per app.
    const cands = [];
    for (let c = 0; c < CANDIDATES_PER_APP; c += 1) {
      cands.push(Math.floor(rnd() * nodeCount));
    }
    locations.set(name, cands.map(addr));

    if (a >= deadCount) {
      // Healthy: the first candidate runs it and is the remembered primary.
      place(cands[0], 'running', dockerName);
      stickies.set(name, addr(cands[0]));
    }
    // Dead-ending apps: nobody runs it, nobody holds it. Every candidate
    // answers 200 with a list the component is not in.
  }

  return {
    apps, locations, placements, stickies, deadCount,
  };
}

module.exports = { build, DEAD_SHARE, CANDIDATES_PER_APP };

// The per-app mechanics both routing loops share: working out where an app is running,
// and running the per-app work in a way that cannot take the cycle down.
//
// These lived inline in the two loops, which is why neither had a test — the loops read
// module-level state and every step inside them reaches the network, so there was nothing
// a test could stand up. Extracted here, both are exercised directly.
const config = require('config');
const log = require('../../lib/log');

const LOCATION_SEARCH_ATTEMPTS = 5;

/**
 * Split a node address into its host and port, IPv6 literals included.
 *
 * The address is bracketed for IPv6 (`[2001:db8::1]:9130`) and bare for IPv4
 * (`1.2.3.4:16127`), so the port cannot be found by splitting on the first colon —
 * doing that to an IPv6 address yields `[2001`.
 *
 * @param {string} address
 * @returns {{host: string, port: string|null}}
 */
function splitAddress(address) {
  const close = address.startsWith('[') ? address.indexOf(']') + 1 : address.indexOf(':');
  if (close < 1) return { host: address, port: null };
  const host = address.slice(0, close);
  const rest = address.slice(close);
  return { host, port: rest.startsWith(':') ? rest.slice(1) : null };
}

/**
 * Where an app is running.
 *
 * The platform's locations feed is the source. An app absent from it is looked up directly
 * a few times before giving up — a freshly deployed app can be running before it appears
 * in the aggregate. A handful of blockbook apps also serve from fixed IPv6 addresses the
 * feed does not carry; those come from config rather than being written into the loop.
 *
 * @param {Object} args
 * @param {string} args.appName
 * @param {Map<string, Array>} args.known the locations feed, app name -> locations
 * @param {Function} args.fetchLocations direct per-app lookup, injectable for tests
 * @param {number} [args.attempts]
 * @returns {Promise<Array<Object>>} locations, possibly empty
 */
async function resolveAppLocations({
  appName,
  known,
  fetchLocations,
  attempts = LOCATION_SEARCH_ATTEMPTS,
}) {
  const locations = known.get(appName) || [];

  let searched = 0;
  while (!locations.length && searched < attempts) {
    log.info(`Application: ${appName} not found in global locations... searching nodes`);
    searched += 1;
    // eslint-disable-next-line no-await-in-loop
    const found = await fetchLocations(appName);
    locations.push(...found);
  }

  // A feed location's port is the node's API port and says nothing about the app; a fixed
  // address carries the port the app itself serves on. Recording that here means no
  // consumer has to infer an address's provenance from its punctuation.
  const fixed = config.staticLocations[appName];
  if (fixed) locations.push(...fixed.map((ip) => ({ ip, servicePort: splitAddress(ip).port })));

  return locations;
}

/**
 * Run per-app work across a cycle, excluding any app that fails.
 *
 * One app must never take the cycle down with it. An app failing is ordinary — it expired,
 * its nodes died, its spec will not resolve — and the correct response is to leave it out
 * of this config, not to abandon every other app's routing update. Whether the cycle as a
 * whole is trustworthy is a separate question, answered from the size of what it built.
 *
 * @param {Array<Object>} apps
 * @param {string} label which loop, for the log line
 * @param {Function} work called with each app
 * @param {Object} [logger]
 * @returns {Promise<Array<string>>} the names of apps excluded by a failure
 */
async function runPerApp(apps, label, work, logger = log) {
  const excluded = [];
  // eslint-disable-next-line no-restricted-syntax
  for (const app of apps) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await work(app);
    } catch (error) {
      excluded.push(app.name);
      logger.error(`${label} Application ${app.name} failed and is excluded from this cycle: ${error.message}`);
    }
  }
  return excluded;
}

module.exports = {
  resolveAppLocations, runPerApp, splitAddress, LOCATION_SEARCH_ATTEMPTS,
};

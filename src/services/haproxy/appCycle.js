'use strict';

// The per-app mechanics both routing loops share: working out where an app is running,
// and running the per-app work in a way that cannot take the cycle down.
//
// These lived inline in the two loops, which is why neither had a test — the loops read
// module-level state and every step inside them reaches the network, so there was nothing
// a test could stand up. Extracted here, both are exercised directly.
const config = require('config');
const { ConditionLog } = require('../conditionLog');
const { parseSocketAddress } = require('../socketAddress');

const LOCATION_SEARCH_ATTEMPTS = 5;

/**
 * Where an app is running.
 *
 * The platform's locations feed is the source. An app absent from it is looked up directly
 * before giving up - a freshly deployed app can be running before it appears in the
 * aggregate. The attempts are for an API that could not be reached: an answer, empty or
 * not, settles the question. A handful of blockbook apps also serve from fixed IPv6
 * addresses the feed does not carry; those come from config rather than being written into
 * the loop.
 *
 * @param {Object} args
 * @param {string} args.appName
 * @param {Map<string, Array>} args.known the locations feed, app name -> locations
 * @param {Function} args.fetchLocations direct per-app lookup answering
 *   `{ answered, locations }`, injectable for tests
 * @param {number} [args.attempts]
 * @returns {Promise<{locations: Array<Object>, requests: number}>} locations, possibly
 *   empty, and how many direct lookups were made
 */
async function resolveAppLocations({
  appName,
  known,
  fetchLocations,
  attempts = LOCATION_SEARCH_ATTEMPTS,
}) {
  const locations = [...(known.get(appName) || [])];

  let requests = 0;
  while (!locations.length && requests < attempts) {
    requests += 1;
    // eslint-disable-next-line no-await-in-loop
    const { answered, locations: found } = await fetchLocations(appName);
    locations.push(...found);
    if (answered) break;
  }

  // A feed location's port is the node's API port and says nothing about the app; a fixed
  // address carries the port the app itself serves on. Recording that here means no
  // consumer has to infer an address's provenance from its punctuation.
  const fixed = config.staticLocations[appName];
  if (fixed) locations.push(...fixed.map((ip) => ({ ip, servicePort: parseSocketAddress(ip).port })));

  return { locations, requests };
}

const appFailures = new ConditionLog();

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
 * @param {{report: Function}} [failures] where each app's failing or not is reported; an
 *   app is logged when it starts failing and when it routes again, not every cycle
 * @returns {Promise<Array<string>>} the names of apps excluded by a failure
 */
async function runPerApp(apps, label, work, failures = appFailures) {
  const excluded = [];
  // eslint-disable-next-line no-restricted-syntax
  for (const app of apps) {
    const key = `${label}:${app.name}`;
    try {
      // eslint-disable-next-line no-await-in-loop
      await work(app);
      failures.report(key, false, () => `${label} Application ${app.name} excluded from routing`);
    } catch (error) {
      excluded.push(app.name);
      failures.report(key, true, () => `${label} Application ${app.name} failed and is excluded from routing: ${error.message}`);
    }
  }
  return excluded;
}

module.exports = { resolveAppLocations, runPerApp, LOCATION_SEARCH_ATTEMPTS };

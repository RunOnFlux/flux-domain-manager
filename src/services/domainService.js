/* eslint-disable no-restricted-syntax */
const config = require('config');
const fs = require('fs').promises;
const log = require('../lib/log');
const ipService = require('./ipService');
const fluxService = require('./flux');
const haproxyTemplate = require('./haproxyTemplate');
const { getCustomDomains } = require('./domain');
const { effectiveRoutes } = require('./domain/effectiveRoutes');
const { DomainOwnershipRegistry } = require('./domain/ownership');
const { executeCertificateOperations, cleanupStaleCerts } = require('./domain/cert');
const applicationChecks = require('./application/checks');
const { getApplicationsToProcess } = require('./application/subset');
const { buildRouteConfigs } = require('./haproxy/buildRouteConfigs');
const { publishRouteConfigs } = require('./haproxy/publication');
const { resolveAppLocations, runPerApp } = require('./haproxy/appCycle');
const { ConditionLog } = require('./conditionLog');
const specLibs = require('./flux/specLibs');
const { startCertRsync } = require('./rsync');
const serviceHelper = require('./serviceHelper');
const httpClients = require('./httpClients');
const alerts = require('./alertService');
const { evaluateListChange } = require('../lib/listGuard');
const { sharedGuardStore } = require('../lib/guardStore');

const { FdmDataFetcher } = require('./flux/dataFetcher');

let myIP = null;

const ownership = new DomainOwnershipRegistry();
const mapOfNamesIps = {};
const mapOfNamesIpsLastHealthy = {}; // timestamp of last successful health check per app
const mapOfNamesIpsLastHeld = {}; // timestamp of the last confirmed HELD answer per app
const mapOfNamesIpsFailures = {}; // consecutive failed checks of the sticky, per app
const mapOfNamesLastSeen = {}; // monotonic ms an app was last present in a pass
const mapOfNamesLastChosen = {}; // the primary the previous pass actually selected
const mapOfNamesExcluded = {}; // apps currently reported as excluded, by pass and name
const ACTIVE_STANDBY_HEALTH_RETRY_COUNT = 3;
const ACTIVE_STANDBY_HEALTH_RETRY_DELAY_MS = 3000;
const ACTIVE_STANDBY_UNHEALTHY_THRESHOLD_MS = 90 * 1000; // 90 seconds before switching away from sticky IP
// How many node probes may be in flight at once during a active-standby pass.
//
// The probes are independent reads of different nodes, so the only thing this
// bounds is our own socket use. Measured on fdm-eu-1-03: 336 active-standby apps, one
// snapshot probe each, median 0.21s - so 32 in flight turns a pass that walked
// them one at a time into roughly one round trip's worth of wall clock.
const ACTIVE_STANDBY_PASS_CONCURRENCY = 32;
// What a node ALREADY believed unreachable is given before we stop waiting.
//
// The first-contact timeout buys headroom for a node that is merely slow. This
// one is different: it is paid on every pass, forever, by every node that is
// down. On the dev FDM one such node was taken through the full ladder 24 times
// in 10 minutes for an answer that had not changed since the first. 2s is still
// more than 3x the slowest real answer measured across 306 fleet primaries.
const ACTIVE_STANDBY_PROBE_KNOWN_BAD_TIMEOUT_MS = 2000;
// When the pass stops paying for RETRIES. It does not cut short the first ask.
//
// The unbounded part of a pass is the ladder: one silent node costs
// timeout + delay + timeout + delay + timeout however fast everything else is.
// This bounds that. It deliberately does NOT bound the first sweep, which is
// bounded already by fleet size over concurrency.
//
// The distinction is the whole point. An earlier form clamped every probe to the
// time left, so once one node's ladder had eaten the budget the later phases got
// microsecond timeouts, every node in them "failed", and 123 healthy nodes were
// written off in a single pass on the dev FDM - each of which answered a direct
// probe in under 0.8s. A node that was never fairly asked has told us nothing:
// it reads UNKNOWN for this pass, and it is NOT remembered as unreachable.
const ACTIVE_STANDBY_PASS_DEADLINE_MS = 20 * 1000;
// How long a node stays written off after its last failure. Refreshed on every
// pass it fails, so a node that is genuinely down never ages out; one that
// leaves the fleet does, rather than sitting in the map forever.
const ACTIVE_STANDBY_UNREACHABLE_TTL_MS = 10 * 60 * 1000;
// How long an app's sticky and health survive after it stops appearing in a pass.
//
// The four per-app maps are keyed by name and nothing removed a deleted app, so
// they grew for the life of the process - and FDM is meant to run for weeks, not
// to be restarted into cleanliness by the next deploy.
//
// Long, deliberately, because the cost is asymmetric. Keeping a dead app's entry
// costs a short string. Dropping a live one costs its `lastHealthy` stamp, which
// is what makes a primary ESTABLISHED - and an unestablished primary gets neither
// the grace nor the confirmation count, so an app that vanished from one pass and
// came back would be defended by nothing for a whole grace period. A day of
// absence is ~3,400 consecutive passes: nothing transient reaches it, and an app
// genuinely gone that long is being reinstalled rather than resumed.
const ACTIVE_STANDBY_STATE_TTL_MS = 24 * 60 * 60 * 1000;
// How often a written-off node is given the FULL timeout again.
//
// Without this the short timeout is a trap of its own: a node that answers in
// 3s - alive, just loaded - would fail a 2s probe every pass and never get a
// long enough one to prove otherwise, so it would stay written off forever on
// the strength of a budget chosen because we thought it was dead. The recheck
// costs one full-length probe a minute per bad node.
const ACTIVE_STANDBY_UNREACHABLE_RECHECK_MS = 60 * 1000;
// Nodes that failed a whole ladder: ip -> { failedAt, lastFullAt } in monotonic
// ms. They are still asked once per pass, so a node that recovers is taken back
// within one - and periodically asked with the full timeout, so a node that is
// slow rather than gone can prove it.
const unreachableNodes = new Map();
// The shortest gap between two active-standby passes, measured start to start.
//
// Chosen against the grace above, not picked for feel. A sticky that fails its
// check is kept while `now - lastHealthy < ACTIVE_STANDBY_UNHEALTHY_THRESHOLD_MS`, and
// lastHealthy is stamped on the last SUCCESSFUL check - so the number of failed
// checks that land inside the grace is how many times FDM confirms a primary is
// gone before it moves the app. At 25s those fall at 25s, 50s and 75s:
//
//     3 x 25000 = 75000 < 90000 = ACTIVE_STANDBY_UNHEALTHY_THRESHOLD_MS
//
// Three confirmations with 15s to spare, and the move happens on the fourth
// check at 100s. 30s would put the third check at exactly 90000, where
// `90000 < 90000` is false and a few milliseconds of jitter decides whether the
// app gets two confirmations or three; 25s keeps it off that boundary. Change
// either constant and this inequality has to be re-checked.
//
// There is a second floor underneath: FluxOS serves listrunningapps from a 15s
// cache (ZelBack routes.js: `cache('15 seconds')`), so passes closer together
// than that read byte-identical answers. 25s clears it.
//
// A floor, not a period. The real cadence is max(this, how long the pass took),
// and the trigger underneath is the appsLocations poll - hardcoded to 10s in
// flux/dataFetcher.js, not derived from the upstream Cache-Control, because the
// API load-balances across nodes whose etags never match so the max-age path is
// never taken. So this floor governs while a pass stays under 25s. It does not
// bound the cadence when a pass runs long, which is why the confirmation count
// below is counted rather than inferred from timing.
const ACTIVE_STANDBY_PASS_MIN_INTERVAL_MS = 25 * 1000;
// A primary is never moved on fewer than this many CONSECUTIVE failed checks,
// whatever the cadence turns out to be.
//
// The grace above answers "has it been unhealthy long enough". This answers
// "have we actually asked enough times", and they are different questions. The
// cadence is max(ACTIVE_STANDBY_PASS_MIN_INTERVAL_MS, how long the pass took), so it is not
// ours to fix: one node that accepts connections and never replies stretches a
// pass by a full probe ladder, and at a 90s cadence `floor(90000 / 90000) = 1`
// - a single failed check would move a domain. Counting the checks makes the
// three confirmations a property of the code rather than an arithmetic accident
// of how fast the pass happened to run.
const ACTIVE_STANDBY_MIN_CONFIRMATIONS = 3;
// Attempts at the per-app location lookup for an app the bulk feed omitted.
const ACTIVE_STANDBY_LOCATION_SEARCH_ATTEMPTS = 5;
let lastActiveStandbyPassStartedAt = 0;
let recentlyConfiguredActiveActiveRouteConfigs = [];
let recentlyConfiguredActiveStandbyRouteConfigs = [];
let activeActiveAppsInitialized = false;
let activeStandbyAppsInitialized = false;
// The size each half last published, for the guard in admitConfiguredHalf.
let configuredHalfStore = sharedGuardStore();
let configuredHalfGuards = {
  nonG: configuredHalfStore.initialState('nonG'),
  G: configuredHalfStore.initialState('G'),
};

let dataFetcher = null;

let activeActiveApps = new Map();
let activeStandbyApps = new Map();
let appsLocations = new Map();

const runQueue = {
  activeStandbyApps: { running: false, queued: false },
  activeActiveApps: { running: false, queued: false },
};

// Generates config file for HAProxy
let fluxIPsForBalancing = []; // current nodes l
async function generateAndReplaceMainHaproxyConfig() {
  try {
    const ui = `${config.uiName}.${config.mainDomain}`;
    const api = `${config.apiName}.${config.mainDomain}`;
    const cloudUi = `${config.cloudUiName}.${config.mainDomain}`;
    let uiPrimary;
    let apiPrimary;
    let cloudUiPrimary;
    if (config.primaryDomain) {
      uiPrimary = `${config.uiName}.${config.primaryDomain}`;
      apiPrimary = `${config.apiName}.${config.primaryDomain}`;
      cloudUiPrimary = `${config.cloudUiName}.${config.primaryDomain}`;
    }

    // get current list of flux ip only stratus
    const fluxIPs = (await fluxService.getFluxIPs('STRATUS')).filter(
      (ip) => !ip.split(':')[1],
    ); // use only stratus for home and on default api port
    if (fluxIPs.length < 100) {
      throw new Error('Invalid Flux List');
    }

    const initialNodeCount = fluxIPsForBalancing.length;

    // Remove nodes that are no longer in the current flux list
    fluxIPsForBalancing = fluxIPsForBalancing.filter((ip) => fluxIPs.includes(ip));
    const removedByFilter = initialNodeCount - fluxIPsForBalancing.length;

    if (removedByFilter > 0) {
      console.log(`Removed ${removedByFilter} nodes no longer in flux list`);
    }

    // Check each existing IP and only keep the ones that pass health check
    const nodeCountBeforeHealthCheck = fluxIPsForBalancing.length;
    const healthyIPs = [];
    for (const ip of fluxIPsForBalancing) {
      // eslint-disable-next-line no-await-in-loop
      const isOK = await applicationChecks.checkMainFlux(
        ip.split(':')[0],
        ip.split(':')[1],
      ); // can be undefined
      if (isOK) {
        healthyIPs.push(ip);
      } else {
        console.log(`removing ${ip} as backend (failed health check)`);
      }
    }
    fluxIPsForBalancing = healthyIPs;

    const removedByHealthCheck = nodeCountBeforeHealthCheck - fluxIPsForBalancing.length;
    if (removedByHealthCheck > 0) {
      console.log(
        `Removed ${removedByHealthCheck} nodes that failed health check`,
      );
    }

    console.log(`Current Ips on backend ${fluxIPsForBalancing.length}`);

    // we want to do some checks on UI and API to verify functionality
    // 1st check is loginphrase
    // 2nd check is communication
    // 3rd is ui
    if (fluxIPsForBalancing.length < 100) {
      console.log(`Found ${fluxIPs.length} STRATUS on default api port`);
      for (const ip of fluxIPs) {
        if (fluxIPsForBalancing.indexOf(ip) >= 0) {
          // eslint-disable-next-line no-continue
          continue;
        }
        // eslint-disable-next-line no-await-in-loop
        const isOK = await applicationChecks.checkMainFlux(
          ip.split(':')[0],
          ip.split(':')[1],
        ); // can be undefined
        if (isOK) {
          fluxIPsForBalancing.push(ip);
          console.log(`adding ${ip} as backend`);
          if (fluxIPsForBalancing.length >= 100) {
            // maximum of 100 for load balancing
            break;
          }
        }
      }
    }

    if (fluxIPsForBalancing.length < config.guards.mainNode.minBackends) {
      throw new Error('Not enough ok nodes, probably error');
    }
    const hc = await haproxyTemplate.createMainHaproxyConfig(
      ui,
      api,
      fluxIPsForBalancing,
      uiPrimary,
      apiPrimary,
      cloudUi,
      cloudUiPrimary,
    );
    // stop logging entire ha proxy config to console
    // console.log(hc);
    const dataToWrite = hc;
    // test haproxy config
    const result = await haproxyTemplate.restartProxy(dataToWrite);
    if (!result.ok) {
      throw new Error(`Haproxy not updated: ${result.reason}`);
    }
    setTimeout(() => {
      generateAndReplaceMainHaproxyConfig();
    }, 30 * 1000);
  } catch (error) {
    log.error(error);
    setTimeout(() => {
      generateAndReplaceMainHaproxyConfig();
    }, 30 * 1000);
  }
}

async function createSSLDirectory() {
  const dir = `/etc/ssl/${config.certFolder}`;
  await fs.mkdir(dir, { recursive: true });
}

function filterMandatoryApps(apps) {
  const subsetConfig = config.subset;
  const startCode = subsetConfig.start.charCodeAt(0);
  const endCode = subsetConfig.end.charCodeAt(0);

  const appsInBucket = [];
  // eslint-disable-next-line no-restricted-syntax
  for (const app of apps) {
    const charCode = app.toUpperCase().charCodeAt(0);
    if (charCode >= startCode && charCode <= endCode) {
      appsInBucket.push(app);
    }
  }

  return appsInBucket;
}

/**
 * Milliseconds on the MONOTONIC clock.
 *
 * Every elapsed-time decision here uses this, never Date.now(). These values
 * decide whether a primary moves: the sticky grace holds an app while
 * `now - lastHealthy < ACTIVE_STANDBY_UNHEALTHY_THRESHOLD_MS`, and the pass floor holds a
 * pass while `now - lastActiveStandbyPassStartedAt < ACTIVE_STANDBY_PASS_MIN_INTERVAL_MS`. A wall clock
 * steps - an NTP correction forward expires a grace that has not expired and
 * moves a healthy app; a step backward makes the difference negative, which
 * compares as inside every window and pins a dead one until the clock catches up.
 *
 * process.hrtime.bigint() counts from an arbitrary origin and cannot go
 * backwards, which is the only property these comparisons need. Nothing here is
 * ever rendered as a date - the log lines report durations - so losing the wall
 * clock costs nothing.
 *
 * @returns {number} monotonic milliseconds
 */
function monotonicMs() {
  return Number(process.hrtime.bigint() / 1000000n);
}

/** When this pass must stop, as monotonic ms. Explicit wins, then relative, then the default. */
function passDeadline(options = {}) {
  if (options.deadlineAt) return options.deadlineAt;
  const { deadlineMs = ACTIVE_STANDBY_PASS_DEADLINE_MS } = options;
  return monotonicMs() + deadlineMs;
}

/**
 * A node answered, so it is no longer written off.
 *
 * The transitions are logged at WARN because warn.log is the only one of these
 * files that keeps more than a few minutes of history - info.log self-truncates,
 * debug.log holds under three. Both ends of the pair go there so a node's health
 * can be reconstructed after the fact, which is the whole point of recording it.
 */
function noteReachable(ip) {
  if (unreachableNodes.delete(ip)) {
    log.warn(`active-standby pass: ${ip} is answering again, no longer written off`);
  }
}

/**
 * A node gave nothing at all. Remember it, so the next pass asks once, briefly.
 *
 * Logged only on the TRANSITION. A node that is down stays down for thousands of
 * passes, and saying so every 25s would bury the moment it changed - which is the
 * only part anybody reads back.
 */
function noteUnreachable(ip, gotFullTimeout) {
  const now = monotonicMs();
  const prior = unreachableNodes.get(ip);
  if (!prior) {
    log.warn(`active-standby pass: ${ip} written off after a full ladder - asked once per pass from here until it answers`);
  }
  unreachableNodes.set(ip, {
    failedAt: now,
    lastFullAt: gotFullTimeout ? now : (prior && prior.lastFullAt) || 0,
  });
}

/**
 * Forget apps that have not been in a pass for a day.
 *
 * Absence from ONE pass means nothing - the upstream feed hiccups, and the whole
 * point of the sticky is to survive that. Absence for a day means the app is
 * gone. Marked on every pass the app appears in, so only a real disappearance
 * ages out.
 */
function pruneActiveStandbyAppState(seenNames, ttlMs = ACTIVE_STANDBY_STATE_TTL_MS) {
  const now = monotonicMs();
  for (const name of seenNames) mapOfNamesLastSeen[name] = now;
  for (const name of Object.keys(mapOfNamesLastSeen)) {
    if (now - mapOfNamesLastSeen[name] >= ttlMs) {
      delete mapOfNamesIps[name];
      delete mapOfNamesIpsLastHealthy[name];
      delete mapOfNamesIpsLastHeld[name];
      delete mapOfNamesIpsFailures[name];
      delete mapOfNamesLastSeen[name];
      delete mapOfNamesLastChosen[name];
    }
  }
}

/** Drop nodes that stopped failing because they stopped existing. */
function pruneUnreachable() {
  const now = monotonicMs();
  for (const [ip, entry] of unreachableNodes) {
    if (now - entry.failedAt > ACTIVE_STANDBY_UNREACHABLE_TTL_MS) unreachableNodes.delete(ip);
  }
}

/** Test seam: the memo outlives a single pass by design, so tests must clear it. */
function resetNodeReachability() {
  unreachableNodes.clear();
}

/**
 * Ask every node once what it is running, retrying only the ones that could not
 * answer.
 *
 * Two things move here, and they are the pass's whole cost.
 *
 * The unit of work is a NODE, not an (app, candidate) pair. The old shape asked
 * a node "are you running app X" once for every app X it was a candidate for,
 * which is the same HTTP call repeated with a different question in mind. One
 * fetch answers all of them, and FluxOS already serves that route from a 15s
 * cache, so a per-pass snapshot is no staler than what it would have returned
 * anyway. It also makes the pass COHERENT: a 479s pass decided its first app
 * from a fleet eight minutes older than its last.
 *
 * The retry ladder waits only on UNKNOWN. A node that answered has settled the
 * question - re-asking three seconds later cannot produce a better answer, and
 * the next pass asks again anyway. Backing off on a definitive negative is what
 * made the production pass what it was: on fdm-eu-1-03, 65 candidate nodes each
 * replied in under a second that they were not running the component, and each
 * cost six seconds of sleep - 390s of a 479s pass. The ladder now costs
 * (retries - 1) x delay for the WHOLE pass rather than per node, and only when
 * something is genuinely unreachable.
 *
 * `into` carries a snapshot already built this pass. Anything it holds is not
 * asked again: the phases run in series, so re-probing a node the previous phase
 * already settled pays a second full ladder for an answer we have. That is what
 * made one unreachable node cost nine probes and two minutes of wall clock, and
 * the pass duration is what sets the cadence - so a slow pass silently shrinks
 * the number of confirmations a primary gets before it is moved.
 *
 * A node that failed a whole ladder is remembered. Next pass it is asked once,
 * with a short timeout, and not laddered again - the ladder tells a blip from an
 * outage, and that question was settled a pass ago. It is still asked EVERY pass,
 * so a node that recovers costs itself one pass, never more.
 *
 * @param {string[]} ips node addresses, duplicates tolerated
 * @param {Function} fetcher applicationChecks.fetchRunningNames or fetchHeldNames
 * @param {Object} [options]
 * @param {number} [options.timeoutMs] first-contact probe timeout
 * @param {number} [options.knownBadTimeoutMs] probe timeout for a node already down
 * @param {number} [options.deadlineAt] monotonic ms the whole pass must stop by
 * @param {Map} [into] snapshot to extend; entries already present are not re-asked
 * @returns {Promise<Map<string, {ok: boolean, names: Set<string>}>>}
 */
async function buildNodeSnapshot(ips, fetcher, options = {}, into = null) {
  const {
    retries = ACTIVE_STANDBY_HEALTH_RETRY_COUNT,
    delayMs = ACTIVE_STANDBY_HEALTH_RETRY_DELAY_MS,
    concurrency = ACTIVE_STANDBY_PASS_CONCURRENCY,
    timeoutMs = applicationChecks.PROBE_TIMEOUT_MS,
    knownBadTimeoutMs = ACTIVE_STANDBY_PROBE_KNOWN_BAD_TIMEOUT_MS,
    unreachableRecheckMs = ACTIVE_STANDBY_UNREACHABLE_RECHECK_MS,
    deadlineAt = monotonicMs() + ACTIVE_STANDBY_PASS_DEADLINE_MS,
  } = options;

  const snapshot = into || new Map();
  let pending = [...new Set(ips)].filter((ip) => !snapshot.has(ip));
  // Nodes we already knew were down, asked once and not laddered. Kept apart from
  // `pending` so the ladder below waits only on nodes whose silence is news.
  const writtenOff = [];
  // Which nodes got the long first-contact budget rather than the short known-bad
  // one, so the recovery recheck is timed off a probe that could actually succeed.
  const gaveFullBudget = new Set();
  // Set when the ladder was cut short. Nothing new is written off in that case:
  // the pass ran out of time, which is not evidence about any node.
  let deadlineCut = false;

  for (let attempt = 1; attempt <= retries && pending.length; attempt += 1) {
    if (attempt > 1) {
      if (monotonicMs() >= deadlineAt) { deadlineCut = true; break; }
      // Named, not just counted. The count alone cannot tell you whether the
      // same node is failing every pass or a different one each time, and it
      // leaves nothing to go and check by hand.
      const named = pending.slice(0, 5).join(', ');
      const andMore = pending.length > 5 ? ` (+${pending.length - 5} more)` : '';
      log.info(`active-standby pass: ${pending.length} node(s) could not be read, retry ${attempt}/${retries}: ${named}${andMore}`);
      // eslint-disable-next-line no-await-in-loop
      await serviceHelper.timeout(delayMs);
      if (monotonicMs() >= deadlineAt) { deadlineCut = true; break; }
    }
    const targets = pending;
    // A node already believed down does not get the headroom kept for one that is
    // merely slow - except on its periodic recheck, or a slow node could never
    // answer its way back out of a budget chosen because we thought it was dead.
    //
    // The budget is NOT trimmed to the time left in the pass. A probe cut to the
    // remaining milliseconds cannot succeed, and its failure would be recorded as
    // the node's fault rather than the clock's.
    const fullBudgetFor = (ip) => {
      const entry = unreachableNodes.get(ip);
      if (!entry) return true;
      return monotonicMs() - entry.lastFullAt >= unreachableRecheckMs;
    };
    const budget = (ip) => {
      const full = fullBudgetFor(ip);
      if (full) gaveFullBudget.add(ip);
      return full ? timeoutMs : knownBadTimeoutMs;
    };
    // eslint-disable-next-line no-await-in-loop
    const settled = await serviceHelper.runWithConcurrency(
      targets.map((ip) => () => fetcher(ip, budget(ip))),
      concurrency,
    );
    pending = [];
    for (let i = 0; i < targets.length; i += 1) {
      const ip = targets[i];
      const result = settled[i];
      const value = result && result.status === 'fulfilled' ? result.value : null;
      // Retried only when nothing came back. A node that answered - even to say
      // it has no such route - has given its final answer, and asking again three
      // seconds later cannot change it.
      if (value && (value.ok || value.answered)) {
        snapshot.set(ip, value);
        noteReachable(ip);
      } else if (attempt === 1 && unreachableNodes.has(ip)) {
        // It was silent last pass and it is silent now. The ladder exists to tell
        // a blip from an outage, and that question was settled a pass ago.
        writtenOff.push(ip);
      } else {
        pending.push(ip);
      }
    }
  }
  // Everything still unanswered is unreadable, and must say so rather than pass
  // for a node that is simply running nothing.
  for (const ip of [...pending, ...writtenOff]) {
    snapshot.set(ip, { ok: false, names: new Set() });
    // UNKNOWN either way - but only a node that got its full ladder has actually
    // told us anything, and only that one is remembered.
    if (!deadlineCut) noteUnreachable(ip, gaveFullBudget.has(ip));
  }
  return snapshot;
}

/**
 * The candidate order the selection walks: lowest digit sum first, sticky removed
 * because it has already had its turn.
 *
 * A TOTAL order, which the previous form was not. It found the lowest-digit-sum
 * address across the whole list, then removed the sticky - so whenever the
 * sticky WAS that address, which is the common case because that is the rule
 * that selected it, no remaining candidate matched, every comparison returned 0,
 * and a stable sort handed back the input order. That order is whatever
 * /apps/locations returned this second, so two FDM instances losing the same
 * primary could promote different nodes for the same app. Sorting on the digit
 * sum itself, with the address as the tiebreak, keeps the documented intent and
 * makes the answer the same everywhere.
 */
function ipDigitSum(ip) {
  return ip
    .split(':')[0]
    .split('.')
    .reduce((a, b) => parseInt(a, 10) + parseInt(b, 10), 0);
}

// An active-standby candidate is an INSTANCE: its node address, and `#{replica}` for a
// named replica. A loose instance is its node, so its key is the node address. A node
// can host co-located replicas, and only one of them may serve.
const instanceKey = (ip, replica) => (replica ? `${ip}#${replica}` : ip);
const nodeOf = (key) => key.split('#')[0];
const replicaOf = (key) => (key.includes('#') ? key.slice(key.indexOf('#') + 1) : null);

function orderedCandidates(ips, stickyIp) {
  const candidates = stickyIp ? ips.filter((ip) => ip !== stickyIp) : [...ips];
  return candidates.sort((a, b) => {
    const d = ipDigitSum(a) - ipDigitSum(b);
    if (d) return d;
    if (a === b) return 0;
    return a < b ? -1 : 1;
  });
}

// One probe per node answers for every instance on it: the instance's own container
// names are matched in that node's answer.
function probeState(snapshot, key, app) {
  return applicationChecks.stateFromNames(
    snapshot.get(nodeOf(key)) || { ok: false, names: new Set() },
    app,
    replicaOf(key),
  );
}

/**
 * Who is RUNNING this app, decided from a snapshot. No I/O, so the pass and the
 * single-app path reach the same verdict by the same rules rather than by two
 * copies of them.
 * @returns {string|null} the chosen ip, or null if nobody is running it
 */
function decideStickyPrimary(app, ips, snapshot) {
  const stickyIp = mapOfNamesIps[app.name];
  if (!stickyIp || !ips.includes(stickyIp)) return null;

  if (probeState(snapshot, stickyIp, app) === applicationChecks.ProbeState.RUNNING) {
    mapOfNamesIpsLastHealthy[app.name] = monotonicMs();
    delete mapOfNamesIpsFailures[app.name];
    return stickyIp;
  }

  // Failed the check. It is released only when it has been unhealthy long
  // enough AND been asked enough times - see ACTIVE_STANDBY_MIN_CONFIRMATIONS for why
  // the second condition is not implied by the first.
  const failures = (mapOfNamesIpsFailures[app.name] || 0) + 1;
  mapOfNamesIpsFailures[app.name] = failures;

  const lastHealthy = mapOfNamesIpsLastHealthy[app.name] || 0;
  const timeSinceHealthy = monotonicMs() - lastHealthy;

  // Both protections need an ESTABLISHED primary - one this FDM has seen serving
  // the app at least once. A sticky with no health behind it is a guess (an
  // entry restored by the held path, or one written by a candidate sweep that
  // has since gone quiet), and defending a guess for three passes would keep an
  // app pointed at a node that has never answered for it.
  const established = lastHealthy > 0;
  const withinGrace = established && timeSinceHealthy < ACTIVE_STANDBY_UNHEALTHY_THRESHOLD_MS;
  const tooFewChecks = established && failures < ACTIVE_STANDBY_MIN_CONFIRMATIONS;

  if (withinGrace || tooFewChecks) {
    log.warn(
      `Active-Standby App ${app.name} sticky IP ${stickyIp} failed health check ${failures}/${ACTIVE_STANDBY_MIN_CONFIRMATIONS} but was healthy ${Math.round(timeSinceHealthy / 1000)}s ago (threshold: ${ACTIVE_STANDBY_UNHEALTHY_THRESHOLD_MS / 1000}s), keeping it`,
    );
    return stickyIp;
  }
  // Silent. This phase releases the sticky; it does not decide what replaces it,
  // and for an operator-stopped app the held phase re-pins this same node on the
  // same pass. The pass reports the outcome at the end, where it is known.
  return null;
}

function decideCandidatePrimary(app, ips, snapshot) {
  for (const candidate of orderedCandidates(ips, mapOfNamesIps[app.name])) {
    if (probeState(snapshot, candidate, app) === applicationChecks.ProbeState.RUNNING) {
      mapOfNamesIps[app.name] = candidate;
      mapOfNamesIpsLastHealthy[app.name] = monotonicMs();
      delete mapOfNamesIpsFailures[app.name];
      return candidate;
    }
  }
  return null;
}

/**
 * Nothing is running this app anywhere. Before dropping it out of FDM entirely,
 * ask whether a node is deliberately HOLDING it - an owner who stopped their
 * master to work on its files has not given up the primary role, and the node
 * still owns the writable copy of the volume.
 *
 * Un-naming it here is how a stop/start cycle moves the primary: the app leaves
 * FDM, the election loses the record of who the primary was, and on restart the
 * selection above runs from scratch and can land on a different node's copy of
 * the data. `pause` never had this problem, because a paused container still
 * looked like a running one and the master was never un-named.
 *
 * Deliberately AFTER the running checks, never before: a node that is actually
 * serving the app always outranks one that is merely holding it.
 *
 * The incumbent is judged FIRST and ALONE. A node that could not answer has not
 * said it stopped holding, and walking on to the next holder on that silence is
 * how one dropped packet moves a domain. The incumbent is released by an explicit
 * "not holding" from itself, by leaving the location list, or by the same 90s the
 * running path already allows before it gives up on a sticky - never by a single
 * unanswered probe.
 *
 * That protects the INCUMBENT only. Once it is genuinely released the loop below
 * takes the first node that reports holding, and the operator-stop lock is
 * durable - no TTL, no sweeper, cleared only by an appstart or an uninstall on
 * that node - so a node stopped once months ago still answers HELD. `appstop`
 * has no primary check and `?global=true` fans it out to every instance, so
 * stale locks are ordinary rather than exotic. Such a node can therefore be
 * picked here, and it is also the node FluxOS's election will never start, so
 * the app stays dark until something actually runs it. That is bounded by the
 * phase order: any node RUNNING the component outranks every holder, so this
 * decides only which stopped node the domain points at, never whether traffic is
 * taken from a live one.
 *
 * @returns {string|null} the chosen ip, or null if nobody holds it
 */
function decideHeldPrimary(app, ips, snapshot) {
  const stickyIp = mapOfNamesIps[app.name];
  const { ProbeState } = applicationChecks;

  if (stickyIp && ips.includes(stickyIp)) {
    const state = probeState(snapshot, stickyIp, app);
    if (state === ProbeState.RUNNING) {
      mapOfNamesIpsLastHeld[app.name] = monotonicMs();
      log.info(
        `Active-Standby App ${app.name} is not running anywhere, but ${stickyIp} reports holding it (operator-stopped) - keeping it as primary`,
      );
      return stickyIp;
    }
    if (state === ProbeState.NOT_RUNNING) {
      // It said so itself, and that retracts the claim. Without this the
      // confirmation outlives the withdrawal: the node goes quiet on the next
      // pass, reads as UNKNOWN, and the grace below reinstates it as primary on
      // the strength of a "yes" it has since taken back.
      delete mapOfNamesIpsLastHeld[app.name];
    }
    if (state === ProbeState.UNKNOWN) {
      const lastHeld = mapOfNamesIpsLastHeld[app.name] || 0;
      const sinceHeld = monotonicMs() - lastHeld;
      if (lastHeld > 0 && sinceHeld < ACTIVE_STANDBY_UNHEALTHY_THRESHOLD_MS) {
        log.warn(
          `Active-Standby App ${app.name} holder ${stickyIp} could not say what it holds, but confirmed holding ${Math.round(sinceHeld / 1000)}s ago - keeping it as primary`,
        );
        return stickyIp;
      }
    }
  }

  for (const candidate of orderedCandidates(ips, stickyIp)) {
    if (probeState(snapshot, candidate, app) === ProbeState.RUNNING) {
      // Named once and then preserved rather than re-derived on each pass, so a
      // holder that goes quiet is not swapped for another while this process
      // lives. It is NOT a restart guarantee: the sticky is module state, a
      // restart starts empty, and the order below decides again from scratch.
      // Two FDMs that restart at different times can therefore disagree about
      // which stopped node a domain points at - bounded, because a holder serves
      // nothing and anything RUNNING outranks it, but real.
      mapOfNamesIps[app.name] = candidate;
      mapOfNamesIpsLastHeld[app.name] = monotonicMs();
      // A new sticky starts clean, exactly as it does on the running path. The
      // counters below belong to the node being replaced: its consecutive
      // failures are not this one's, and its last-healthy stamp would make this
      // one look established before it has ever answered.
      delete mapOfNamesIpsFailures[app.name];
      delete mapOfNamesIpsLastHealthy[app.name];
      log.info(
        `Active-Standby App ${app.name} is not running anywhere, but ${candidate} reports holding it (operator-stopped) - keeping it as primary`,
      );
      return candidate;
    }
  }
  return null;
}

/**
 * Report an application entering or leaving exclusion, and nothing in between.
 *
 * An app with no locations stays that way for as long as it is dead, so a line
 * per pass is the same sentence about the same name every 25 seconds, in the one
 * log that keeps real history. Only the two edges carry information: it went
 * dark, and it came back.
 *
 * @param {string} label pass this app belongs to, for the message
 * @param {string} name application name
 * @param {boolean} excluded whether it is excluded on this pass
 */
function reportExclusion(label, name, excluded) {
  const key = `${label}:${name}`;
  if (excluded === Boolean(mapOfNamesExcluded[key])) return;
  if (excluded) {
    mapOfNamesExcluded[key] = true;
    log.warn(`${label} Application ${name} is excluded. Not running properly?`);
  } else {
    delete mapOfNamesExcluded[key];
    log.warn(`${label} Application ${name} is no longer excluded`);
  }
}

/**
 * The one thing about an active-standby app worth keeping in warn.log: its primary changed.
 *
 * Compared against what the LAST PASS CHOSE, not against the sticky. A released
 * sticky is not a move - the held phase re-pins the same node most of the time -
 * and mapOfNamesIps keeps its stale entry when a pass resolves nothing, so the
 * sticky would read as a change on every pass. Only a transition is logged,
 * which is what keeps this affordable in a file that self-truncates at 25MB.
 */
function reportPrimaryChanges(chosen) {
  chosen.forEach((ip, name) => {
    const previous = name in mapOfNamesLastChosen ? mapOfNamesLastChosen[name] : undefined;
    if (previous === ip) return;
    mapOfNamesLastChosen[name] = ip;
    if (previous === undefined) {
      // First pass this app has been in. Nothing moved; nothing to report.
      if (ip) log.info(`Active-Standby App ${name} primary is ${ip}`);
      else log.warn(`Active-Standby App ${name} has no primary - nothing is running or holding it`);
    } else if (ip && previous) {
      log.warn(`Active-Standby App ${name} PRIMARY MOVED ${previous} -> ${ip}`);
    } else if (ip) {
      log.warn(`Active-Standby App ${name} has a primary again: ${ip}`);
    } else {
      log.warn(`Active-Standby App ${name} lost its primary ${previous} - nothing is running or holding it`);
    }
  });
}

/**
 * Pick the primary for every active-standby app in one pass.
 *
 * Two snapshots and two pure decisions. The held snapshot covers only the apps
 * nothing is running - 28 of 336 on fdm-eu-1-03 - so the endpoint most of a
 * mixed-version fleet cannot serve yet is asked about almost nowhere.
 *
 * @param {Object[]} apps active-standby application specifications
 * @param {Map<string, Array>} locations app name -> location records, or bare ips
 * @param {Object} [options]
 * @returns {Promise<Map<string, string|null>>} app name -> chosen ip
 */
async function selectActiveStandbyPrimaries(apps, locations, options = {}) {
  pruneUnreachable();
  pruneActiveStandbyAppState(apps.map((a) => a.name), options.appStateTtlMs);
  // ONE deadline for the pass, not one per phase - the phases run in series, and
  // it is the total that sets the cadence.
  const passOptions = { ...options, deadlineAt: passDeadline(options) };
  const ipsFor = (app) => (locations.get(app.name) || [])
    .map((loc) => (typeof loc === 'string' ? loc : loc.ip && instanceKey(loc.ip, loc.replica)))
    .filter(Boolean);

  const withIps = apps.map((app) => ({ app, ips: ipsFor(app) })).filter((e) => e.ips.length);

  const chosen = new Map();

  // Phase 1: the remembered primaries, and nothing else.
  //
  // A healthy app needs exactly one probe - the node it is already on - and on
  // the dev FDM that is what almost every app is on almost every pass. Probing
  // every candidate of every app instead cost 900 probes where 334 would do,
  // and at a 25s cadence that difference is the whole load story: the other
  // candidates only matter for an app whose primary has actually stopped
  // answering, and phase 2 asks about exactly those.
  const stickyIps = withIps
    .map(({ app, ips }) => {
      const sticky = mapOfNamesIps[app.name];
      return sticky && ips.includes(sticky) ? sticky : null;
    })
    .filter(Boolean);

  const stickySnapshot = await buildNodeSnapshot(
    stickyIps.map(nodeOf),
    applicationChecks.fetchRunningNames,
    passOptions,
  );

  const needCandidates = [];
  for (const { app, ips } of withIps) {
    const ip = decideStickyPrimary(app, ips, stickySnapshot);
    if (ip) chosen.set(app.name, ip);
    else needCandidates.push({ app, ips });
  }

  // Phase 2: the wider sweep, for the apps whose primary did not hold - plus
  // every app that has no remembered primary at all, which is how a newly
  // deployed one gets its first.
  const unresolved = [];
  if (needCandidates.length) {
    // Extends phase 1's snapshot. Every sticky is in there already - including
    // the ones that failed - so this asks only about nodes nobody has asked yet.
    const candidateSnapshot = await buildNodeSnapshot(
      needCandidates.flatMap((e) => e.ips).map(nodeOf),
      applicationChecks.fetchRunningNames,
      passOptions,
      stickySnapshot,
    );
    for (const { app, ips } of needCandidates) {
      const ip = decideCandidatePrimary(app, ips, candidateSnapshot);
      if (ip) chosen.set(app.name, ip);
      else unresolved.push({ app, ips });
    }
  }

  // Phase 3: nothing is running these anywhere - ask who is HOLDING them.
  if (unresolved.length) {
    // A node that gave no reply at all to the running probe will give none to
    // this one either - same process, same socket. Carrying those over as
    // unreadable reaches the identical verdict (UNKNOWN) without paying a
    // second ladder for it. A node that answered with a STATUS is not carried
    // over: it is alive, and it may well serve this route.
    const seed = new Map();
    for (const [ip, value] of stickySnapshot) {
      if (!value.ok && !value.answered) seed.set(ip, value);
    }
    const heldSnapshot = await buildNodeSnapshot(
      unresolved.flatMap((e) => e.ips).map(nodeOf),
      applicationChecks.fetchHeldNames,
      passOptions,
      seed,
    );
    for (const { app, ips } of unresolved) {
      chosen.set(app.name, decideHeldPrimary(app, ips, heldSnapshot));
    }
  }

  for (const app of apps) if (!chosen.has(app.name)) chosen.set(app.name, null);
  reportPrimaryChanges(chosen);
  return chosen;
}

/**
 * How an app's instances are ordered inside its haproxy backend.
 *
 * For most apps this is cosmetic - haproxy spreads traffic over every server -
 * but it must still be STABLE, because the whole config is rebuilt each pass and
 * a single differing byte triggers `service haproxy reload`. It was not stable:
 * the order came straight from api.runonflux.io/apps/locations, which returns
 * the same instances in a different order from one call to the next. Measured on
 * fdm-eu-1-03: 64 reloads in 11 minutes, 63 passes reporting "changes detected"
 * and not one reporting none, with consecutive configs differing by 998 and 842
 * lines that were the same servers in a new order.
 *
 * For a syncFirst app it is NOT cosmetic. haproxy marks every server after the
 * first as `backup` (haproxyTemplate.js), so position zero is the only live one -
 * the write target of a replicated app.
 *
 * @param {string[]} ips bare `ip:port` strings
 * @param {Object[]} appLocations the location records they came from
 * @returns {string[]} the same ips, ordered oldest instance first
 */
function orderBySeniority(ips, appLocations) {
  const runningSince = new Map(
    (appLocations || []).map((loc) => [loc.ip, loc.runningSince || '']),
  );
  // runningSince is ISO-8601, which sorts correctly as text.
  //
  // An instance that never reported one sorts LAST, and that is a DELIBERATE
  // divergence from FluxOS's compareInstanceSeniority
  // (ZelBack/src/services/utils/instanceOrdering.js), which sorts it first so a
  // still-settling instance is never counted as surplus. The key is the same;
  // the null goes the other way. Here position zero takes the writes of a
  // replicated app, and "no idea how long this has been up" is the weakest claim
  // on that, not the strongest. Where the two disagree, FDM's position 0 will
  // not be FluxOS's primary - but this ordering is only ever reached when the
  // sharedDB cluster could not be asked, and the cluster's own answer outranks
  // it whenever there is one.
  //
  // A sampled 7,085 location records all carried the field; it is not guaranteed
  // to be there, so this handles its absence rather than assuming it.
  return [...ips].sort((a, b) => {
    const sa = runningSince.get(a) || '';
    const sb = runningSince.get(b) || '';
    if (sa !== sb) {
      if (!sa) return 1;
      if (!sb) return -1;
      return sa < sb ? -1 : 1;
    }
    if (a === b) return 0;
    return a < b ? -1 : 1;
  });
}

/**
 * The order the sharedDB cluster itself puts its members in.
 *
 * Authoritative, and it works: clusterStatus[0] is the operator's elected master
 * and each entry's `ip` is `ip:port`, the same shape as appIps. Verified against
 * production - the live backend of every sharedDB app on all four FDMs matches
 * that app's reported masterIP. Nothing here should second-guess it; a timestamp
 * heuristic pointing writes at a node the database does not consider master is
 * worse than any ordering problem it would solve.
 *
 * What it does correct is the miss. indexOf returns -1 for an instance the
 * cluster does not list - deployed, but not joined yet - and -1 sorts AHEAD of
 * index 0, which would put a node that is not in the cluster in front of the
 * master and hand it the writes. Unlisted members sort last, in seniority order
 * among themselves.
 *
 * @param {string[]} ips bare `ip:port` strings
 * @param {string[]} clusterOrder `ip:port` strings, master first
 * @param {Object[]} appLocations the location records, for the tiebreak
 * @returns {string[]} ips in cluster order, non-members last
 */
function orderByCluster(ips, clusterOrder, appLocations) {
  const rank = (ip) => {
    const i = clusterOrder.indexOf(ip);
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
  };
  const senior = orderBySeniority(ips, appLocations);
  return [...ips].sort(
    (a, b) => rank(a) - rank(b) || senior.indexOf(a) - senior.indexOf(b),
  );
}

let appIpsOnAppsChecks = [];
async function addAppIps(app, ip, deployment) {
  const isCheckOK = await applicationChecks.checkApplication(app, ip, deployment);
  if (isCheckOK) {
    appIpsOnAppsChecks.push(ip);
  }
}

/**
 * To delay by a number of milliseconds.
 * @param {number} ms Number of milliseconds.
 * @returns {Promise} Promise object.
 */
function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

let updateHaproxyRunning = false;
async function updateHaproxy(haproxyRouteConfigs) {
  try {
    if (updateHaproxyRunning) {
      await delay(1000);
      await updateHaproxy(haproxyRouteConfigs);
      return;
    }
    updateHaproxyRunning = true;
    const hc = await haproxyTemplate.createAppsHaproxyConfig(haproxyRouteConfigs);
    // stop logging entire ha proxy config to console
    // console.log(hc);
    const dataToWrite = hc;
    // test haproxy config
    const result = await haproxyTemplate.restartProxy(dataToWrite);
    if (!result.ok) {
      throw new Error(`Haproxy not updated: ${result.reason}`);
    }
  } finally {
    updateHaproxyRunning = false;
  }
}

/**
 * Whether a half's freshly computed list may replace what it last published.
 *
 * A half that collapses - every active-standby app missing because the spec list briefly came
 * back empty, a location outage - would otherwise be published whole, and the
 * frontends it drops release their ports. The rule is lib/listGuard's; a refused
 * list leaves the published half untouched.
 *
 * @param {'nonG'|'G'} half
 * @param {number} count entries the pass computed
 * @param {number} [now] monotonic ms
 * @returns {boolean}
 */
function admitConfiguredHalf(half, count, now = monotonicMs()) {
  const { configPass } = config.guards;
  const limits = {
    floor: configPass.floor,
    maxDropRatio: configPass.maxDropRatio,
    confirmMs: configPass.confirmMs,
  };
  const lastPublished = configuredHalfGuards[half].lastAcceptedCount;
  const verdict = evaluateListChange(count, configuredHalfGuards[half], limits, now);
  configuredHalfGuards[half] = verdict.state;

  const key = `config-refused:${half}`;

  if (!verdict.accept) {
    const message = `${half} pass computed ${count} entries (last published `
      + `${lastPublished ?? 'none'}), reason ${verdict.reason}; the published ${half} config is kept`;
    // Before a half has ever published on this box there is nothing to protect:
    // log only.
    if (lastPublished === null) {
      log.info(message);
    } else {
      alerts.raise(key, message, { afterMs: configPass.alertAfterMs });
    }
    return false;
  }

  if (verdict.reason === 'confirmed') {
    log.warn(`${half} pass: ${count} entries (last published ${lastPublished ?? 'none'}) `
      + `held for ${Math.round(configPass.confirmMs / 1000)}s; publishing it`);
  }
  configuredHalfStore.recordAccepted(half, count);
  alerts.resolve(key);
  return true;
}

/**
 * @param {ReturnType<import('../lib/guardStore').createGuardStore>} [store]
 */
function resetConfiguredHalfGuards(store = sharedGuardStore()) {
  configuredHalfStore = store;
  configuredHalfGuards = {
    nonG: configuredHalfStore.initialState('nonG'),
    G: configuredHalfStore.initialState('G'),
  };
}

// Resolve an app to its version-normalized DeploymentSpec and append its backend
// routes to the config. Version-blind: legacy and v9 apps take the same path. The
// Domain overrides are carried into the resolved routes via deserialize. Custom domains
// this app does not own (another live app registered them first) are skipped.
async function appendRouteConfigs(routeConfigs, app, backends, isActiveStandby) {
  const instance = await specLibs.deserialize(app);
  // One resolved deployment per replica actually running. A named replica's effective
  // component is a general deep merge of its override entry, so nothing about its routes
  // can be assumed to match its siblings' — resolve each and read its own routes.
  // The declared view is always resolved: it carries the app's public identity — the
  // domains it answers on, its backend names and its tuning — which must not shift with
  // whichever replicas happen to be running.
  const deployments = new Map([[null, await specLibs.resolveDeployment(instance, null)]]);
  // eslint-disable-next-line no-restricted-syntax
  for (const replica of new Set(backends.map((b) => b.replica ?? null))) {
    // eslint-disable-next-line no-await-in-loop
    deployments.set(replica, await specLibs.resolveDeployment(instance, replica));
  }
  const disowned = [];
  const ownsDomain = (domain) => {
    const owned = ownership.ownsDomain(domain, app.name);
    if (!owned) disowned.push(domain);
    return owned;
  };
  const onConflict = (domain, fields, replica) => {
    log.warn(`${app.name}: replica ${replica} disagrees with an earlier replica on ${domain} (${fields.join(', ')}); keeping the first`);
  };
  routeConfigs.push(...buildRouteConfigs(deployments, app.name, backends, isActiveStandby, app.syncFirst, ownsDomain, onConflict));
  if (disowned.length) {
    log.warn(`${app.name}: skipped ${disowned.length} custom domain(s) owned by another app: ${disowned.join(', ')}`);
  }
}

// The location states that mean "this replica is going away" — flux-shutdownd moves an
// app through them before the node stops it, and the state rides the location row out
// through fluxos. Anything else (including an absent state) counts as in rotation, so an
// older fluxos that doesn't report state fails open.
const DRAIN_STATES = new Set(['draining', 'stopping']);
const isDraining = (location) => DRAIN_STATES.has(location.state);

// Drain state, and apps with nothing healthy to route to, both persist across cycles, and
// the loops run every time the fetcher emits locations — every 10 seconds, unconditionally.
// Reporting them through a ConditionLog logs the start, restates it periodically with how
// long it has been going, and logs the recovery, instead of one line per app per cycle.
const drainingBackends = new ConditionLog();
const unhealthyApps = new ConditionLog();
const missingMandatory = new ConditionLog();

// Without this a shutting-down node just silently disappears from the config, with nothing
// to confirm the flux-shutdownd -> fluxos -> FDM chain actually delivered the state.
function logDraining(appName, draining) {
  drainingBackends.report(
    appName,
    draining.length > 0,
    () => `${appName}: ${draining.length} backend(s) draining, held out of rotation: ${draining.join(', ')}`,
  );
}

// A mandatory app is a canary: FDM expects it to exist, and its absence says something is
// off with this director's view. It no longer gates publishing — that is decided from the
// size of the built config — but it is worth saying out loud.
function reportMissingMandatoryApps(appsOK, label) {
  let { mandatoryApps } = config;
  if (config.useSubset) {
    mandatoryApps = filterMandatoryApps(mandatoryApps);
  }
  mandatoryApps.forEach((name) => {
    const missing = !appsOK.find((app) => app.name === name);
    missingMandatory.report(`${label}:${name}`, missing, () => `${label}: mandatory app ${name} is missing from this cycle`);
  });
}

// Pair the ordered ip list back up with the locations it came from, so each running
// instance becomes one backend carrying its replica name. A node hosting two co-located
// replicas appears once in the ip list but yields two backends — which is the whole
// point: they are distinct servers on distinct ports. Ordering follows the resolved ip
// order (health checks, shared-db operator ordering), draining backends last.
function toBackends(appIps, drainingIps, appLocations) {
  const byIp = new Map();
  appLocations.forEach((location) => {
    if (!byIp.has(location.ip)) byIp.set(location.ip, []);
    byIp.get(location.ip).push(location);
  });
  const take = (ips, draining) => {
    const out = [];
    const emitted = new Set();
    ips.forEach((ip) => {
      if (emitted.has(ip)) return;
      emitted.add(ip);
      const locations = (byIp.get(ip) || []).filter((l) => isDraining(l) === draining);
      // An ip with no matching location still routes — the blockbook apps inject bare ips
      // that were never in the location data at all.
      if (!locations.length) {
        out.push({ ip, replica: null, draining });
        return;
      }
      locations.forEach((l) => out.push({ ip, replica: l.replica ?? null, draining }));
    });
    return out;
  };
  return take(appIps, false).concat(take(drainingIps, true));
}

// The shared-db operator's API port, or null when the app runs no operator. The operator
// reports which node currently holds the cluster primary, which decides backend order.
// Version-blind: read off the resolved deployment's routes, which are already reduced to
// the ports FDM publishes, so the API port is the last one the operator still routes.
// Whether an image is one of the shared-db components config.sharedDbRouting names.
function isSharedDbImage(image) {
  const lowered = (image || '').toLowerCase();
  return config.sharedDbRouting.components.some((rule) => lowered.includes(rule.image));
}

// Whether an app runs a shared-db component, whatever its spec version.
function runsSharedDb(deployment) {
  return Object.values(deployment.components).some((component) => isSharedDbImage(component.image));
}

function sharedDbApiPort(deployment) {
  const isOperator = (name) => isSharedDbImage(deployment.components[name]?.image);
  const operatorRoutes = effectiveRoutes(deployment).filter((route) => isOperator(route.componentName));
  return operatorRoutes.length ? operatorRoutes[operatorRoutes.length - 1].hostPort : null;
}

// Resolve the ordered, in-rotation backend IPs for an app from its live locations —
// the one place config assembly consults runtime state. Three concerns that used to be
// smeared through the routing loop live here now:
//   drain      - a replica the platform reports draining/stopping is pulled from rotation
//                (state rides the location row from flux-shutdownd -> fluxos)
//   ordering   - app-specific health checks, or the shared-db operator's live cluster
//                status (primary first); the renderer stays pure over the result
//   syncFirst  - version-blind, from the typed sync mode (legacy r: and v9 both map to
//                requiresSyncBeforeStart), set on the app for the backup-server rendering
// Returns `{ appIps, drainingIps, backends }`. `backends` is what config assembly
// consumes — one entry per running instance, carrying its replica name and drain state,
// so co-located replicas stay distinguishable. `appIps`/`drainingIps` remain the node
// address lists, which is what the mandatory-app emptiness check wants (a node hosting
// two replicas is still one node) and what /appips reports.
// Sets app.syncFirst as a side effect (the renderer reads it).
async function resolveBackends(app, appLocations) {
  // Drain: keep only backends the platform still considers active.
  const live = appLocations.filter((l) => !isDraining(l));
  const drainingIps = appLocations.filter(isDraining).map((l) => l.ip);
  logDraining(app.name, drainingIps);
  let appIps = [];

  // One resolved view for every branch below: the probe ports, the shared-db operator's
  // API port, and syncFirst all read it.
  const deployment = await specLibs.resolveDeployment(await specLibs.deserialize(app), null);
  const sharedDb = runsSharedDb(deployment);

  if (applicationChecks.applicationWithChecks(app)) {
    // Per-app coded checks hit the network, so responses arrive out of order; sort by ip.
    let promiseArray = [];
    for (const [i, location] of live.entries()) {
      promiseArray.push(addAppIps(app, location.ip, deployment));
      if ((i + 1) % 10 === 0) {
        // eslint-disable-next-line no-await-in-loop
        await Promise.allSettled(promiseArray);
        promiseArray = [];
        // eslint-disable-next-line no-loop-func
        appIpsOnAppsChecks.forEach((loc) => appIps.push(loc));
        appIpsOnAppsChecks = [];
      }
    }
    if (promiseArray.length > 0) {
      await Promise.allSettled(promiseArray);
      appIpsOnAppsChecks.forEach((loc) => appIps.push(loc));
      appIpsOnAppsChecks = [];
    }
    serviceHelper.sortIPAddresses(appIps);
  } else if (sharedDb) {
    // Ordered before the cluster has its say, so the fallbacks below start from a fixed
    // order rather than from whatever the locations API happened to return. Which ports
    // reach the load balancer is decided in effectiveRoutes, not here - this only orders.
    appIps = orderBySeniority(live.map((location) => location.ip), live);
    log.info(`sharedDBApps: Found app ${app.name} using sharedDB`);
    const apiPort = sharedDbApiPort(deployment);
    if (apiPort) {
      let operatorClusterStatus = null;
      const httpTimeout = 5000;
      // eslint-disable-next-line no-restricted-syntax
      for (const ip of appIps) {
        const url = `http://${ip.split(':')[0]}:${apiPort}/status`;
        log.info(`sharedDBApps: ${app.name} going to check operator status on url ${url}`);
        // eslint-disable-next-line no-await-in-loop
        const operatorStatus = await httpClients.nodeChecks
          .get(url, { timeout: httpTimeout })
          .catch((error) => log.error(`sharedDBApps: ${app.name} operatorStatus error: ${error}`));
        if (operatorStatus && operatorStatus.data && operatorStatus.data.status === 'OK') {
          operatorClusterStatus = operatorStatus.data.clusterStatus.map((cluster) => cluster.ip);
          break;
        }
      }
      if (operatorClusterStatus) {
        appIps = orderByCluster(appIps, operatorClusterStatus, live);
        log.info(`Application ${app.name} was setup as a sharedDBApps`);
      } else {
        // No operator could be reached, so the cluster cannot say who its master is
        // and this has to choose one. Oldest instance first: for a replicated app it
        // is the one most likely to hold the complete data, and it is the same key
        // FluxOS's own active-standby election uses (runningSince ascending).
        appIps = orderBySeniority(appIps, live);
      }
    }
  } else {
    // The branch most apps take. Order carries no meaning here - haproxy spreads
    // traffic over every server - but it has to be FIXED, because the locations API
    // returns the same instances in a different order each call and the config is
    // byte-compared to decide whether to reload haproxy.
    appIps = serviceHelper.sortIPAddresses(live.map((location) => location.ip));
  }

  // syncFirst makes haproxy mark every server after the first as `backup`, so
  // position zero is the only one taking traffic - the write target of a shared-db
  // database, whose members acknowledge a write before the others have applied it.
  // It is set for shared-db apps and nothing else: an `r:` volume is
  // syncthing-replicated across instances that are ALL meant to run and ALL meant
  // to serve. An app that needs a single serving instance says so with activeStandby.
  // eslint-disable-next-line no-param-reassign
  app.syncFirst = sharedDb;
  return { appIps, drainingIps, backends: toBackends(appIps, drainingIps, appLocations) };
}

/**
 *
 * @param {Map<string, Object>} globalAppSpecs Pre filtered active-active applications
 */
async function generateActiveActiveHaproxyConfig() {
  const startTime = process.hrtime.bigint();
  let appsProcessingTimeNs = 0;
  let slowestApp = { name: null, ns: 0 };
  // What the pass cost api.runonflux.io - see the active-standby pass for the reasoning.
  let searchRequests = 0;

  try {
    log.info('Active-Active Mode STARTED');

    // just use the map in the future
    const globalAppSpecs = activeActiveApps.values();

    // filter applications based on config
    const applicationSpecifications = getApplicationsToProcess(globalAppSpecs);

    // The directory haproxy loads its certificates from. The certificate process fills
    // it and rsyncs it across the group; this loop only needs it to exist.
    await createSSLDirectory();
    log.info('SSL directory checked');
    reportMissingMandatoryApps(applicationSpecifications, 'Active-Active');
    const routeConfigs = [];
    await runPerApp(applicationSpecifications, 'Active-Active', async (app) => {
      const appStartTime = process.hrtime.bigint();
      const { locations: appLocations, requests } = await resolveAppLocations({
        appName: app.name,
        known: appsLocations,
        fetchLocations: fluxService.getApplicationLocation,
      });
      searchRequests += requests;

      try {
        if (appLocations.length > 0) {
          const { appIps, backends } = await resolveBackends(app, appLocations);
          unhealthyApps.report(app.name, appIps.length < 1, () => `Active-Active Application ${app.name} has no healthy instances`);
          await appendRouteConfigs(routeConfigs, app, backends, false);
          reportExclusion('Active-Active', app.name, false);
        } else {
          reportExclusion('Active-Active', app.name, true);
        }
      } finally {
        const elapsedNs = Number(process.hrtime.bigint() - appStartTime);
        appsProcessingTimeNs += elapsedNs;
        slowestApp = elapsedNs > slowestApp.ns ? { name: app.name, ns: elapsedNs } : slowestApp;
      }
    });

    const elapsedAppsS = Math.round((appsProcessingTimeNs / 1_000_000_000) * 100) / 100;
    const slowestS = Math.round((slowestApp.ns / 1_000_000_000) * 100) / 100;
    log.info(`Total Active-Active apps processing time. Elapsed: ${elapsedAppsS}, slowest ${slowestApp.name} at ${slowestS}, location searches: ${searchRequests}`);

    if (!admitConfiguredHalf('nonG', routeConfigs.length)) return;

    // Active-active configs always lead the combined config, so this loop's own configs
    // go first. The assignment is deliberately after the await: if haproxy rejects the
    // config, publishRouteConfigs throws and the memo keeps its previous value, so the
    // next cycle rebuilds and retries instead of matching the memo and skipping.
    const outcome = await publishRouteConfigs({
      next: routeConfigs,
      remembered: recentlyConfiguredActiveActiveRouteConfigs,
      counterpart: recentlyConfiguredActiveStandbyRouteConfigs,
      counterpartFirst: false,
      update: updateHaproxy,
      // Readiness is deliberately NOT gated on the publish succeeding, and must stay that
      // way. It gates /appips, which FluxOS uses to elect the single master for
      // active-standby apps; on a 503 from every region the node falls back to
      // self-election. A rejected config is app-set-driven and so hits every FDM at once,
      // which is exactly the correlated case that fallback handles worst.
      onChanged: () => { activeActiveAppsInitialized = true; },
      onPublish: (combined) => {
        log.info('Changes in Active-Active Mode configuration detected');
        log.info(`Active-Active Mode updating haproxy with length: ${combined.length}`);
      },
    });

    if (outcome.action === 'unchanged') return;
    recentlyConfiguredActiveActiveRouteConfigs = outcome.remember;
  } catch (error) {
    log.error(error);
  } finally {
    const elapsedNs = Number(process.hrtime.bigint() - startTime);
    const elapsedS = Math.round((elapsedNs / 1_000_000_000) * 100) / 100;
    log.info(`Active-Active Mode ENDED. Elapsed: ${elapsedS}s`);
  }
}

async function generateActiveStandbyHaproxyConfig() {
  const sinceLast = monotonicMs() - lastActiveStandbyPassStartedAt;
  if (lastActiveStandbyPassStartedAt && sinceLast < ACTIVE_STANDBY_PASS_MIN_INTERVAL_MS) {
    const waitMs = ACTIVE_STANDBY_PASS_MIN_INTERVAL_MS - sinceLast;
    log.info(`Active-Standby Mode holding ${Math.round(waitMs / 1000)}s - the previous pass started ${Math.round(sinceLast / 1000)}s ago and the nodes would answer from the same cache`);
    await serviceHelper.timeout(waitMs);
  }
  lastActiveStandbyPassStartedAt = monotonicMs();
  const startTime = process.hrtime.bigint();
  // What the pass cost api.runonflux.io, reported with its duration. An
  // application absent from the bulk feed is asked about directly, and that is
  // the only outbound request the pass makes per application.
  let searchRequests = 0;

  try {
    log.info('Active-Standby Mode STARTED');

    const globalAppSpecs = activeStandbyApps.values();

    // filter applications based on config
    const applicationSpecifications = getApplicationsToProcess(globalAppSpecs);

    // The directory haproxy loads its certificates from. The certificate process fills
    // it and rsyncs it across the group; this loop only needs it to exist.
    await createSSLDirectory();
    log.info('SSL directory checked');
    // Locations for the apps the bulk feed did not carry - a handful per pass.
    //
    // The attempts are for an API that could not be REACHED. It replies `success`
    // with an empty list in under 200ms for an app nothing is running, and the
    // 15 applications the feed omits are dead ones that answer that way every
    // time - so an answer, empty or not, settles the question. Same rule as the
    // node probes: a status is final, silence is not.
    //
    // Searched concurrently across apps, so five attempts against a genuinely
    // slow API cost one app's wall clock rather than the whole pass's.
    //
    // The result is deliberately not cached back into appsLocations. That map is
    // replaced wholesale every 10s by the locations poll, so anything written
    // here is discarded long before the next pass reads it.
    const locationsForPass = new Map();
    const needSearch = [];
    for (const app of applicationSpecifications) {
      const cached = appsLocations.get(app.name);
      if (cached && cached.length) locationsForPass.set(app.name, cached);
      else needSearch.push(app);
    }
    if (needSearch.length) {
      const searched = await serviceHelper.runWithConcurrency(
        needSearch.map((app) => async () => {
          let requests = 0;
          for (let attempt = 1; attempt <= ACTIVE_STANDBY_LOCATION_SEARCH_ATTEMPTS; attempt += 1) {
            requests += 1;
            // eslint-disable-next-line no-await-in-loop
            const { answered, locations: found } = await fluxService
              .getApplicationLocation(app.name);
            if (found.length) {
              log.info(`Application: ${app.name} was missing from the bulk feed, found on ${found.length} node(s) by search`);
              return [app.name, found, requests];
            }
            if (answered) return [app.name, [], requests];
          }
          return [app.name, [], requests];
        }),
        ACTIVE_STANDBY_PASS_CONCURRENCY,
      );
      for (const result of searched) {
        if (result.status === 'fulfilled') {
          const [name, found, requests] = result.value;
          searchRequests += requests;
          if (found && found.length) locationsForPass.set(name, found);
        }
      }
    }

    // Fixed addresses the feed does not carry, as the active-active loop adds them.
    for (const app of applicationSpecifications) {
      const fixed = config.staticLocations[app.name];
      if (fixed) locationsForPass.set(app.name, [...(locationsForPass.get(app.name) || []), ...fixed.map((ip) => ({ ip }))]);
    }

    // A draining or stopping instance is never selected as the active one.
    const liveLocations = new Map([...locationsForPass].map(([name, locations]) => [
      name, locations.filter((l) => !isDraining(l)),
    ]));
    const selected = await selectActiveStandbyPrimaries(applicationSpecifications, liveLocations);

    const routeConfigs = [];
    await runPerApp(applicationSpecifications, 'Active-Standby', async (app) => {
      const appLocations = locationsForPass.get(app.name) || [];
      if (appLocations.length > 0) {
        // Active-standby routes to a single INSTANCE - one replica on one node, not a
        // whole node, since a node may host co-located replicas and only one of them may
        // serve. Draining instances were dropped from selection; they render in
        // maintenance here.
        const selectedKey = selected.get(app.name);
        const draining = appLocations
          .filter(isDraining)
          .map((l) => ({ ip: l.ip, replica: l.replica || null, draining: true }));
        logDraining(app.name, draining.map((b) => b.ip));
        unhealthyApps.report(app.name, !selectedKey, () => `Active-Standby Application ${app.name} has no instance fit to serve`);
        if (selectedKey) {
          const instance = { ip: nodeOf(selectedKey), replica: replicaOf(selectedKey) };
          // Exactly the selected instance goes into rotation. Its co-located siblings are
          // standbys and must not appear as servers, or the single-writer guarantee is
          // gone the moment haproxy balances between them.
          const backends = [{ ...instance, draining: false }, ...draining];
          await appendRouteConfigs(routeConfigs, app, backends, true);
        }
        reportExclusion('G', app.name, false);
      } else {
        reportExclusion('G', app.name, true);
      }
    });

    if (!admitConfiguredHalf('G', routeConfigs.length)) return;

    // Mirror of the active-active loop; active-active leads the combined config, so this
    // loop's counterpart goes first. Same memo ordering — advanced on the deferred path,
    // but only after a successful publish.
    const outcome = await publishRouteConfigs({
      next: routeConfigs,
      remembered: recentlyConfiguredActiveStandbyRouteConfigs,
      counterpart: recentlyConfiguredActiveActiveRouteConfigs,
      counterpartFirst: true,
      update: updateHaproxy,
      // This loop announces the change before deciding whether it can publish yet; the
      // active-active loop announces it only when it actually publishes. Both preserved,
      // as is readiness not being gated on the publish (see the active-active loop).
      onChanged: () => {
        log.info('Changes in Active-Standby Mode configuration detected');
        activeStandbyAppsInitialized = true;
      },
      onPublish: (combined) => {
        log.info(`Active-Standby Mode updating haproxy with length: ${combined.length}`);
      },
    });

    if (outcome.action === 'unchanged') return;
    recentlyConfiguredActiveStandbyRouteConfigs = outcome.remember;
  } catch (error) {
    log.error(error);
  } finally {
    const elapsedNs = Number(process.hrtime.bigint() - startTime);
    const elapsedS = Math.round((elapsedNs / 1_000_000_000) * 100) / 100;
    log.info(`Active-Standby Mode ENDED. Elapsed: ${elapsedS}s, location searches: ${searchRequests}`);
  }
}

async function obtainCertificatesMode() {
  try {
    // get applications on the network (including decrypted enterprise apps)
    let applicationSpecifications = await dataFetcher.getDecryptedSpecs();

    // filter applications based on config
    applicationSpecifications = getApplicationsToProcess(
      applicationSpecifications,
    );
    // Collect all unique custom domains across all apps for a single parallel batch.
    // Version-blind: resolve each spec and read its cert-eligible custom domains; a spec
    // that can't resolve is logged and skipped.
    const domainSet = new Set();
    for (const appSpecs of applicationSpecifications) {
      let deployment;
      try {
        // eslint-disable-next-line no-await-in-loop
        const instance = await specLibs.deserialize(appSpecs);
        // eslint-disable-next-line no-await-in-loop
        deployment = await specLibs.resolveDeployment(instance, null);
      } catch (error) {
        log.error(`skipping ${appSpecs.name}: ${error.message}`);
        // eslint-disable-next-line no-continue
        continue;
      }
      getCustomDomains(deployment).forEach((d) => domainSet.add(d));
    }
    const allCustomDomains = [...domainSet];
    let certsChanged = false;
    if (allCustomDomains.length) {
      log.info(`Processing ${allCustomDomains.length} unique custom domains from ${applicationSpecifications.length} apps`);
      const certOps = await executeCertificateOperations(allCustomDomains, myIP);
      certsChanged = certOps.certsChanged;
      const orphansRemoved = await cleanupStaleCerts();
      certsChanged = certsChanged || orphansRemoved;
    }
    log.info('Certificates obtained');
    if (certsChanged) {
      startCertRsync();
    }
    setTimeout(() => {
      obtainCertificatesMode();
    }, 15 * 60 * 1000);
  } catch (error) {
    log.error(error);
    setTimeout(() => {
      obtainCertificatesMode();
    }, 15 * 60 * 1000);
  }
}

// Both roles read the platform's app specs over the same mTLS channel; only the routing
// role runs the fetch loops on top of it. The key/cert/CA are symlinked to the correct
// files on every box, and are read here — so a box that has not received them yet fails
// at this call rather than on the first request.
function createDataFetcher() {
  return new FdmDataFetcher({
    keyPath: '/etc/ssl/private/fdm-arcane.key',
    certPath: '/etc/ssl/certs/fdm-arcane.pem',
    caPath: '/etc/ssl/certs/fdm-arcane-ca.pem',
    fluxApiBaseUrl: 'https://api.runonflux.io/',
    specDecrypt: config.specDecrypt,
  });
}

/** Initiates application processing. Before the haproxy app config is generated,
 * it ensure that the app specs and permanent messages are populated. It then
 * runs
 * @returns {Promise<void>}
 */
async function startApplicationProcessing() {
  if (dataFetcher) return;
  const fetcher = createDataFetcher();

  const locationsHandler = async (appsLocs) => {
    if (appsLocs) appsLocations = appsLocs;

    const handler = async (name, handlerState, runner) => {
      const state = handlerState;

      if (state.queued && state.running) {
        console.log('appsLocationsUpdated event received, while '
          + `an update already queued for: ${name}, skipping`);

        return;
      }

      if (state.running) {
        console.log('appsLocationsUpdated event received while an '
          + `update is running for: ${name}. Queueing next update.`);
        state.queued = true;

        return;
      }

      if (state.queued) state.queued = false;

      state.running = true;

      await runner();

      if (state.queued) {
        await runner();
        state.queued = false;
      }

      state.running = false;
    };

    const promises = [
      handler('activeStandbyApps', runQueue.activeStandbyApps, generateActiveStandbyHaproxyConfig),
      handler('activeActiveApps', runQueue.activeActiveApps, generateActiveActiveHaproxyConfig),
    ];

    await Promise.all(promises);
  };

  fetcher.on(
    'appSpecsUpdated',
    async (specs) => {
      ownership.setAppDomains(specs.appFqdns);
      activeActiveApps = specs.activeActiveApps;
      activeStandbyApps = specs.activeStandbyApps;
    },
  );

  fetcher.on('permMessagesUpdated', (permMessages) => {
    ownership.setPermanentMessages(permMessages);
  });

  fetcher.on('appsLocationsUpdated', locationsHandler);

  // We just run these once prior to the fetch loops ss the data is populated
  await fetcher.permMessageRunner();
  await fetcher.appSpecRunner();
  await fetcher.appsLocationsRunner();

  await locationsHandler();

  fetcher.startAppSpecLoop();
  fetcher.startPermMessagesLoop();
  fetcher.startAppsLocationsLoop();

  // Published only once the loops are running, because it doubles as the "already
  // started" guard above: a boot that fails part-way leaves it unset, so the retry
  // builds a fresh fetcher instead of returning at the guard and never starting.
  dataFetcher = fetcher;
}

// The certificate role matches each custom domain against the addresses this group
// answers on, and this node's own is one of them. It is discovered asynchronously, so
// that role waits for it; routing reads no address of its own and does not wait.
function whenPublicIPKnown(run) {
  myIP = ipService.localIP();
  if (!myIP) {
    log.warn('Awaiting FDM IP address...');
    setTimeout(() => whenPublicIPKnown(run), 5 * 1000);
    return;
  }
  log.info(`public IP: ${myIP}`);
  run();
}

const BOOT_RETRY_MS = 30 * 1000;

// A start that survives its own failure. Both boots touch the network and the filesystem
// — the platform API, the mTLS key a box may not have received yet — and the sequence
// this replaces only ever caught a synchronous throw: application processing is async, so
// its rejection sailed past the try/catch and killed the process. That matters because a
// process that dies while booting dies again immediately, and pm2 stops restarting after
// max_restarts and leaves it errored. So a failed boot is logged and retried here, and
// the retry is short — the failures it sees are "the network is not up yet" or "a human
// has to put a file on this box", and neither is helped by waiting a quarter of an hour.
function retryOnFailure(boot) {
  const retry = (error) => {
    log.error(error);
    setTimeout(() => retryOnFailure(boot), BOOT_RETRY_MS);
  };
  try {
    const booting = boot();
    if (booting && typeof booting.catch === 'function') booting.catch(retry);
  } catch (error) {
    retry(error);
  }
}

/** FDM: publish haproxy routing — for applications under appSubDomain.mainDomain, or
 * for the main node domain, per config.manageApps. One process per director.
 */
function startRouting() {
  retryOnFailure(async () => {
    log.info('Initiating FDM routing services...');
    ipService.start();
    applicationChecks.startBlockheightRefresh();
    if (config.manageApps) {
      // Runs once, to add the event listeners the fetch loops drive.
      await startApplicationProcessing();
      log.info('Flux Main Application Domain Service initiated.');
    } else {
      generateAndReplaceMainHaproxyConfig();
      log.info('Flux Main Node Domain Service initiated.');
    }
  });
}

/** CDM: obtain and renew the owners' custom-domain certificates, and rsync them to the
 * group. One process, on the renewal primary only. It runs no routing and holds no
 * haproxy state, so it never writes a config.
 */
function startCertificates() {
  retryOnFailure(() => {
    log.info('Initiating CDM certificate services...');
    ipService.start();
    dataFetcher = createDataFetcher();
    whenPublicIPKnown(() => {
      obtainCertificatesMode();
      startCertRsync();
      log.info('CDM Certificate Service initialized.');
    });
  });
}

function getRouteConfigs() {
  return {
    activeActiveRouteConfigs: recentlyConfiguredActiveActiveRouteConfigs,
    activeStandbyRouteConfigs: recentlyConfiguredActiveStandbyRouteConfigs,
    activeActiveAppsInitialized,
    activeStandbyAppsInitialized,
  };
}

// Exported for tests. selectActiveStandbyPrimaries' decision rests on module-level sticky state,
// and the ordering it enforces - a node RUNNING the app always outranks one that
// is merely holding it - is the property that makes the held fallback safe to
// deploy ahead of the FluxOS release that serves /apps/heldcomponents.
function getActiveStandbyStickyIp(appName) {
  return mapOfNamesIps[appName];
}

function setActiveStandbyStickyState(appName, ip, lastHealthyMs) {
  mapOfNamesIps[appName] = ip;
  delete mapOfNamesIpsFailures[appName];
  if (lastHealthyMs === undefined) {
    delete mapOfNamesIpsLastHealthy[appName];
  } else {
    mapOfNamesIpsLastHealthy[appName] = lastHealthyMs;
  }
}

function resetActiveStandbyStickyState(appName) {
  delete mapOfNamesLastSeen[appName];
  delete mapOfNamesLastChosen[appName];
  delete mapOfNamesExcluded[`G:${appName}`];
  delete mapOfNamesExcluded[`Active-Active:${appName}`];
  delete mapOfNamesIps[appName];
  delete mapOfNamesIpsLastHealthy[appName];
  delete mapOfNamesIpsLastHeld[appName];
  delete mapOfNamesIpsFailures[appName];
}

module.exports = {
  startRouting,
  startCertificates,
  getRouteConfigs,
  selectActiveStandbyPrimaries,
  orderBySeniority,
  orderByCluster,
  monotonicMs,
  getActiveStandbyStickyIp,
  setActiveStandbyStickyState,
  resetActiveStandbyStickyState,
  resetNodeReachability,
  reportExclusion,
  admitConfiguredHalf,
  resetConfiguredHalfGuards,
  resolveBackends,
};

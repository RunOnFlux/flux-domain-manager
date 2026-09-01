/* eslint-disable no-restricted-syntax */
const config = require('config');
const fs = require('fs').promises;
const log = require('../lib/log');
const ipService = require('./ipService');
const fluxService = require('./flux');
const haproxyTemplate = require('./haproxyTemplate');
const {
  processApplications,
  getUnifiedDomains,
  getCustomDomains,
} = require('./domain');
const { executeCertificateOperations, cleanupStaleCerts } = require('./domain/cert');
const applicationChecks = require('./application/checks');
const { getCustomConfigs } = require('./application/custom');
const { getApplicationsToProcess } = require('./application/subset');
const { DOMAIN_TYPE } = require('./constants');
const { startCertRsync } = require('./rsync');
const serviceHelper = require('./serviceHelper');

const { FdmDataFetcher } = require('./flux/dataFetcher');

let myIP = null;
let myFDMnameORip = null;

let unifiedAppsDomains = [];
const mapOfNamesIps = {};
const mapOfNamesIpsLastHealthy = {}; // timestamp of last successful health check per app
const mapOfNamesIpsLastHeld = {}; // timestamp of the last confirmed HELD answer per app
const G_APP_HEALTH_RETRY_COUNT = 3;
const G_APP_HEALTH_RETRY_DELAY_MS = 3000;
const G_APP_UNHEALTHY_THRESHOLD_MS = 90 * 1000; // 90 seconds before switching away from sticky IP
// How many node probes may be in flight at once during a G pass.
//
// The probes are independent reads of different nodes, so the only thing this
// bounds is our own socket use. Measured on fdm-eu-1-03: 336 g: apps, one
// snapshot probe each, median 0.21s - so 32 in flight turns a pass that walked
// them one at a time into roughly one round trip's worth of wall clock.
const G_PASS_CONCURRENCY = 32;
// The shortest gap between two G passes, measured start to start.
//
// Chosen against the grace above, not picked for feel. A sticky that fails its
// check is kept while `now - lastHealthy < G_APP_UNHEALTHY_THRESHOLD_MS`, and
// lastHealthy is stamped on the last SUCCESSFUL check - so the number of failed
// checks that land inside the grace is how many times FDM confirms a primary is
// gone before it moves the app. At 25s those fall at 25s, 50s and 75s:
//
//     3 x 25000 = 75000 < 90000 = G_APP_UNHEALTHY_THRESHOLD_MS
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
// A floor, not a period. The pass is driven by the appsLocations poll, so the
// real cadence is max(this, the trigger interval) - and the trigger is whatever
// `Cache-Control: max-age` the upstream API returns (flux/dataFetcher.js),
// which is not ours to set. Measured on the dev FDM at roughly 18.75s, so this
// governs. While a pass took eight minutes none of it could matter; at ten
// seconds it does.
const G_PASS_MIN_INTERVAL_MS = 25 * 1000;
let lastGPassStartedAt = 0;
let recentlyConfiguredApps = [];
let recentlyConfiguredGApps = [];
let nonGAppsInitialized = false;
let gAppsInitialized = false;

let dataFetcher = null;

let permanentMessages = [];
let nonGApps = new Map();
let gApps = new Map();
let appsLocations = new Map();

const runQueue = {
  gApps: { running: false, queued: false },
  nonGApps: { running: false, queued: false },
};

async function checkDomainOwnership(domain, appName) {
  try {
    if (!domain) {
      return true;
    }
    const filteredDomains = unifiedAppsDomains.filter((entry) => entry.domains.includes(domain.toLowerCase()));
    const ourAppExists = filteredDomains.find(
      (existing) => existing.name === appName,
    );
    if (filteredDomains.length >= 2 && ourAppExists) {
      // we have multiple apps that has the same domain assigned;
      // check permanent messages for these apps
      const appNames = [];
      filteredDomains.forEach((x) => {
        appNames.push(x.name);
      });
      // now we have only the messages that touch the apps that have the domain
      const filteredPermanentMessages = permanentMessages.filter((mes) => appNames.includes(mes.appSpecifications.name));
      const adjustedFilteredPermMessages = [];
      filteredPermanentMessages.forEach((message) => {
        const stringedMessage = JSON.stringify(message).toLowerCase();
        if (stringedMessage.includes(domain.toLowerCase())) {
          adjustedFilteredPermMessages.push(message);
        }
      });
      const sortedPermanentFilteredMessages = adjustedFilteredPermMessages.sort(
        (a, b) => {
          if (a.height < b.height) return -1;
          if (a.height > b.height) return 1;
          return 0;
        },
      );
      const oldestMessage = sortedPermanentFilteredMessages[0];
      if (oldestMessage.appSpecifications.name === appName) {
        return true;
      }
      log.warn(`Custom domain ${domain} not owned by ${appName}`);
      return false;
    }
    return true;
  } catch (error) {
    return true;
  }
}

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

    if (fluxIPsForBalancing.length < 10) {
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
    const successRestart = await haproxyTemplate.restartProxy(dataToWrite);
    if (!successRestart) {
      throw new Error('Invalid HAPROXY Config File!');
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
 * `now - lastHealthy < G_APP_UNHEALTHY_THRESHOLD_MS`, and the pass floor holds a
 * pass while `now - lastGPassStartedAt < G_PASS_MIN_INTERVAL_MS`. A wall clock
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

function selectLowestDigitSumIp(ips) {
  let chosenIp = ips[0];
  let chosenIpSum = ips[0]
    .split(':')[0]
    .split('.')
    .reduce((a, b) => parseInt(a, 10) + parseInt(b, 10), 0);
  for (const ip of ips) {
    const sum = ip
      .split(':')[0]
      .split('.')
      .reduce((a, b) => parseInt(a, 10) + parseInt(b, 10), 0);
    if (sum < chosenIpSum) {
      chosenIp = ip;
      chosenIpSum = sum;
    }
  }
  return chosenIp;
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
 * @param {string[]} ips node addresses, duplicates tolerated
 * @param {Function} fetcher applicationChecks.fetchRunningNames or fetchHeldNames
 * @param {Object} [options]
 * @returns {Promise<Map<string, {ok: boolean, names: Set<string>}>>}
 */
async function buildNodeSnapshot(ips, fetcher, options = {}) {
  const {
    retries = G_APP_HEALTH_RETRY_COUNT,
    delayMs = G_APP_HEALTH_RETRY_DELAY_MS,
    concurrency = G_PASS_CONCURRENCY,
  } = options;

  const snapshot = new Map();
  let pending = [...new Set(ips)];

  for (let attempt = 1; attempt <= retries && pending.length; attempt += 1) {
    if (attempt > 1) {
      log.info(`G pass: ${pending.length} node(s) could not be read, retry ${attempt}/${retries}`);
      // eslint-disable-next-line no-await-in-loop
      await serviceHelper.timeout(delayMs);
    }
    const targets = pending;
    // eslint-disable-next-line no-await-in-loop
    const settled = await serviceHelper.runWithConcurrency(
      targets.map((ip) => () => fetcher(ip)),
      concurrency,
    );
    pending = [];
    for (let i = 0; i < targets.length; i += 1) {
      const result = settled[i];
      const value = result && result.status === 'fulfilled' ? result.value : null;
      // Retried only when nothing came back. A node that answered - even to say
      // it has no such route - has given its final answer, and asking again three
      // seconds later cannot change it.
      if (value && (value.ok || value.answered)) snapshot.set(targets[i], value);
      else pending.push(targets[i]);
    }
  }
  // Everything still pending is unreadable, and must say so rather than pass for
  // a node that is simply running nothing.
  for (const ip of pending) snapshot.set(ip, { ok: false, names: new Set() });
  return snapshot;
}

/**
 * The candidate order the selection walks: lowest digit sum first, sticky removed
 * because it has already had its turn.
 */
function orderedCandidates(ips, stickyIp) {
  const lowestDigitSumIp = selectLowestDigitSumIp(ips);
  const candidates = stickyIp ? ips.filter((ip) => ip !== stickyIp) : [...ips];
  candidates.sort((a, b) => {
    if (a === lowestDigitSumIp) return -1;
    if (b === lowestDigitSumIp) return 1;
    return 0;
  });
  return candidates;
}

function probeState(snapshot, ip, app) {
  return applicationChecks.stateFromNames(
    snapshot.get(ip) || { ok: false, names: new Set() },
    app,
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
    return stickyIp;
  }
  // Failed the check - keep it anyway if it was healthy recently enough.
  const lastHealthy = mapOfNamesIpsLastHealthy[app.name] || 0;
  const timeSinceHealthy = monotonicMs() - lastHealthy;
  if (lastHealthy > 0 && timeSinceHealthy < G_APP_UNHEALTHY_THRESHOLD_MS) {
    log.warn(
      `G App ${app.name} sticky IP ${stickyIp} failed health check but was healthy ${Math.round(timeSinceHealthy / 1000)}s ago (threshold: ${G_APP_UNHEALTHY_THRESHOLD_MS / 1000}s), keeping it`,
    );
    return stickyIp;
  }
  log.warn(
    `G App ${app.name} sticky IP ${stickyIp} failed health check for >${G_APP_UNHEALTHY_THRESHOLD_MS / 1000}s, selecting new IP`,
  );
  return null;
}

function decideCandidatePrimary(app, ips, snapshot) {
  for (const candidate of orderedCandidates(ips, mapOfNamesIps[app.name])) {
    if (probeState(snapshot, candidate, app) === applicationChecks.ProbeState.RUNNING) {
      mapOfNamesIps[app.name] = candidate;
      mapOfNamesIpsLastHealthy[app.name] = monotonicMs();
      return candidate;
    }
  }
  return null;
}

function decideRunningPrimary(app, ips, snapshot) {
  return decideStickyPrimary(app, ips, snapshot) || decideCandidatePrimary(app, ips, snapshot);
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
 * unanswered probe. That matters because the operator-stop lock is durable: a
 * node carrying a stale one answers HELD indefinitely, and is also the node
 * FluxOS's election will never pick, so handing it the domain points the app at
 * an instance that is not coming back.
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
        `G App ${app.name} is not running anywhere, but ${stickyIp} reports holding it (operator-stopped) - keeping it as primary`,
      );
      return stickyIp;
    }
    if (state === ProbeState.UNKNOWN) {
      const lastHeld = mapOfNamesIpsLastHeld[app.name] || 0;
      const sinceHeld = monotonicMs() - lastHeld;
      if (lastHeld > 0 && sinceHeld < G_APP_UNHEALTHY_THRESHOLD_MS) {
        log.warn(
          `G App ${app.name} holder ${stickyIp} could not say what it holds, but confirmed holding ${Math.round(sinceHeld / 1000)}s ago - keeping it as primary`,
        );
        return stickyIp;
      }
    }
  }

  for (const candidate of orderedCandidates(ips, stickyIp)) {
    if (probeState(snapshot, candidate, app) === ProbeState.RUNNING) {
      // The sticky is preserved rather than re-derived, so an FDM restart during
      // a stop cannot silently promote a different instance.
      mapOfNamesIps[app.name] = candidate;
      mapOfNamesIpsLastHeld[app.name] = monotonicMs();
      log.info(
        `G App ${app.name} is not running anywhere, but ${candidate} reports holding it (operator-stopped) - keeping it as primary`,
      );
      return candidate;
    }
  }
  return null;
}

/**
 * Pick the primary for every g: app in one pass.
 *
 * Two snapshots and two pure decisions. The held snapshot covers only the apps
 * nothing is running - 28 of 336 on fdm-eu-1-03 - so the endpoint most of a
 * mixed-version fleet cannot serve yet is asked about almost nowhere.
 *
 * @param {Object[]} apps g: application specifications
 * @param {Map<string, Array>} locations app name -> location records, or bare ips
 * @param {Object} [options]
 * @returns {Promise<Map<string, string|null>>} app name -> chosen ip
 */
async function selectGPrimaries(apps, locations, options = {}) {
  const ipsFor = (app) => (locations.get(app.name) || [])
    .map((loc) => (typeof loc === 'string' ? loc : loc.ip))
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
    stickyIps,
    applicationChecks.fetchRunningNames,
    options,
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
    const candidateSnapshot = await buildNodeSnapshot(
      needCandidates.flatMap((e) => e.ips),
      applicationChecks.fetchRunningNames,
      options,
    );
    for (const { app, ips } of needCandidates) {
      const ip = decideCandidatePrimary(app, ips, candidateSnapshot);
      if (ip) chosen.set(app.name, ip);
      else unresolved.push({ app, ips });
    }
  }

  // Phase 3: nothing is running these anywhere - ask who is HOLDING them.
  if (unresolved.length) {
    const heldSnapshot = await buildNodeSnapshot(
      unresolved.flatMap((e) => e.ips),
      applicationChecks.fetchHeldNames,
      options,
    );
    for (const { app, ips } of unresolved) {
      chosen.set(app.name, decideHeldPrimary(app, ips, heldSnapshot));
    }
  }

  for (const app of apps) if (!chosen.has(app.name)) chosen.set(app.name, null);
  return chosen;
}

/**
 * The single-app path. Same rules, same order and the same sticky state as the
 * pass - it just builds its snapshots from one app's candidates.
 */
async function selectIPforG(ips, app, options = {}) {
  if (!ips || !ips.length) return null;
  const runningSnapshot = await buildNodeSnapshot(ips, applicationChecks.fetchRunningNames, options);
  const running = decideRunningPrimary(app, ips, runningSnapshot);
  if (running) return running;
  const heldSnapshot = await buildNodeSnapshot(ips, applicationChecks.fetchHeldNames, options);
  return decideHeldPrimary(app, ips, heldSnapshot);
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
 * For an isRdata app it is NOT cosmetic. haproxy marks every server after the
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
  // runningSince is ISO-8601, which sorts correctly as text. An instance that
  // never reported one sorts LAST: for a replicated app position zero takes the
  // writes, and "no idea how long this has been up" is the weakest claim on it,
  // not the strongest. No record on the fleet is currently missing the field.
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
async function addAppIps(app, ip) {
  const isCheckOK = await applicationChecks.checkApplication(app, ip);
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
async function updateHaproxy(haproxyAppsConfig) {
  try {
    if (updateHaproxyRunning) {
      await delay(1000);
      await updateHaproxy(haproxyAppsConfig);
      return;
    }
    updateHaproxyRunning = true;
    const hc = await haproxyTemplate.createAppsHaproxyConfig(haproxyAppsConfig);
    // stop logging entire ha proxy config to console
    // console.log(hc);
    const dataToWrite = hc;
    // test haproxy config
    const successRestart = await haproxyTemplate.restartProxy(dataToWrite);
    if (!successRestart) {
      throw new Error('Invalid HAPROXY Config File!');
    }
  } finally {
    updateHaproxyRunning = false;
  }
}

/**
 * The configured-app list, and the one question anybody asks about it.
 *
 * Every guard in addConfigurations was a linear scan of the array for a matching
 * `domain` - nine of them per app, over an array that grows with every app. At
 * the 2,483 backends fdm-eu-1-03 carries that is ~55M string comparisons,
 * invisible inside a 479s pass; at 10k apps it is ~5.6 BILLION, and it is CPU on
 * the event loop, so no amount of concurrency touches it.
 *
 * The index lives in here rather than beside the array on purpose: there is no
 * way to add an entry without indexing it, so the two cannot drift apart.
 */
function createConfiguredApps() {
  const entries = [];
  const domains = new Set();
  return {
    hasDomain(domain) {
      return domains.has(domain);
    },
    push(entry) {
      entries.push(entry);
      domains.add(entry.domain);
    },
    get length() {
      return entries.length;
    },
    list() {
      return entries;
    },
  };
}

function addConfigurations(configuredApps, app, appIps, gMode) {
  const domains = getUnifiedDomains(app);
  const customConfigs = getCustomConfigs(app, gMode);
  let timeout = null;
  if (app.version <= 3) {
    const timeoutConfig = app.enviromentParameters?.find((att) => typeof att === 'string' && att.toLowerCase().startsWith('timeout='));
    if (timeoutConfig) {
      [, timeout] = timeoutConfig.split('=');
    }
    for (let i = 0; i < app.ports.length; i += 1) {
      const configuredApp = {
        name: app.name,
        appName: `${app.name}_${app.ports[i]}`,
        domain: domains[i],
        port: app.ports[i],
        ips: appIps,
        isRdata: app.isRdata,
        ...customConfigs[i],
        timeout,
      };

      configuredApps.push(configuredApp);
      if (typeof app.domains[i] === 'string') {
        const portDomains = app.domains[i].split(',');
        for (let portDomain of portDomains) {
          // eslint-disable-next-line no-param-reassign
          portDomain = portDomain
            .replace('https://', '')
            .replace('http://', '')
            .replace(/[&/\\#,+()$~%'":*?<>{}]/g, ''); // . is allowed
          const isDomainAllowed = checkDomainOwnership(portDomain, app.name);
          if (isDomainAllowed === false) {
            // eslint-disable-next-line no-continue
            continue;
          }
          // TODO here check on permanent apps if this app name is true owner of the portDomain
          if (portDomain.includes('www.')) {
            // eslint-disable-next-line prefer-destructuring, no-param-reassign
            portDomain = portDomain.split('www.')[1];
          }
          // prevention for double backend on custom domains, can be improved
          const domainAssigned = configuredApps.hasDomain(portDomain);
          if (
            portDomain
            && portDomain.includes('.')
            && portDomain.length > 3
            && !portDomain
              .toLowerCase()
              .includes(
                `${config.appSubDomain}.${config.mainDomain.split('.')[0]}`,
              )
            && !domainAssigned
          ) {
            // prevent double backend
            const domainExists = configuredApps.hasDomain(portDomain.toLowerCase());
            if (!domainExists) {
              const configuredAppCustom = {
                name: app.name,
                appName: `${app.name}_${app.ports[i]}`,
                domain: portDomain,
                port: app.ports[i],
                ips: appIps,
                isRdata: app.isRdata,
                ...customConfigs[i],
                timeout,
              };
              configuredApps.push(configuredAppCustom);
            }
            const wwwAdjustedDomain = `www.${portDomain.toLowerCase()}`;
            if (wwwAdjustedDomain) {
              const domainExistsB = configuredApps.hasDomain(wwwAdjustedDomain);
              if (!domainExistsB) {
                const configuredAppCustom = {
                  name: app.name,
                  appName: `${app.name}_${app.ports[i]}`,
                  domain: wwwAdjustedDomain,
                  port: app.ports[i],
                  ips: appIps,
                  isRdata: app.isRdata,
                  ...customConfigs[i],
                  timeout,
                };
                configuredApps.push(configuredAppCustom);
              }
            }

            const testAdjustedDomain = `test.${portDomain.toLowerCase()}`;
            if (testAdjustedDomain) {
              const domainExistsB = configuredApps.hasDomain(testAdjustedDomain);
              if (!domainExistsB) {
                const configuredAppCustom = {
                  name: app.name,
                  appName: `${app.name}_${app.ports[i]}`,
                  domain: testAdjustedDomain,
                  port: app.ports[i],
                  ips: appIps,
                  isRdata: app.isRdata,
                  ...customConfigs[i],
                  timeout,
                };
                configuredApps.push(configuredAppCustom);
              }
            }
          }
        }
      }
    }
    const mainApp = {
      name: app.name,
      appName: `${app.name}_${app.ports[0]}`,
      domain: domains[domains.length - 1],
      port: app.ports[0],
      ips: appIps,
      isRdata: app.isRdata,
      ...customConfigs[customConfigs.length - 1],
      timeout,
    };
    configuredApps.push(mainApp);
  } else {
    let j = 0;
    for (const component of app.compose) {
      timeout = null;
      const timeoutConfig = component.environmentParameters?.find((att) => typeof att === 'string' && att.toLowerCase().startsWith('timeout='));
      if (timeoutConfig) {
        [, timeout] = timeoutConfig.split('=');
      }
      for (let i = 0; i < component.ports.length; i += 1) {
        const configuredApp = {
          name: app.name,
          appName: `${app.name}_${component.name}_${component.ports[i]}`,
          domain: domains[j],
          port: component.ports[i],
          ips: appIps,
          isRdata: app.isRdata,
          ...customConfigs[j],
          timeout,
        };
        configuredApps.push(configuredApp);
        if (typeof component.domains[i] === 'string') {
          const portDomains = component.domains[i].split(',');
          // eslint-disable-next-line no-loop-func
          for (let portDomain of portDomains) {
            // eslint-disable-next-line no-param-reassign
            portDomain = portDomain
              .replace('https://', '')
              .replace('http://', '')
              .replace(/[&/\\#,+()$~%'":*?<>{}]/g, ''); // . is allowed
            const isDomainAllowed = checkDomainOwnership(portDomain, app.name);
            if (isDomainAllowed === false) {
              // eslint-disable-next-line no-continue
              continue;
            }
            if (portDomain.includes('www.')) {
              // eslint-disable-next-line prefer-destructuring, no-param-reassign
              portDomain = portDomain.split('www.')[1];
            }
            // prevention for double backend on custom domains, can be improved
            const domainAssigned = configuredApps.hasDomain(portDomain);
            if (
              portDomain
              && portDomain.includes('.')
              && portDomain.length >= 3
              && !portDomain
                .toLowerCase()
                .includes(
                  `${config.appSubDomain}.${config.mainDomain.split('.')[0]}`,
                )
              && !domainAssigned
            ) {
              if (
                !portDomain.includes(
                  `${config.appSubDomain}${config.mainDomain.split('.')[0]}`,
                )
              ) {
                // prevent double backend
                const domainExists = configuredApps.hasDomain(portDomain.toLowerCase());
                if (!domainExists) {
                  const configuredAppCustom = {
                    name: app.name,
                    appName: `${app.name}_${component.name}_${component.ports[i]}`,
                    domain: portDomain,
                    port: component.ports[i],
                    ips: appIps,
                    isRdata: app.isRdata,
                    ...customConfigs[j],
                    timeout,
                  };
                  configuredApps.push(configuredAppCustom);
                }

                const wwwAdjustedDomain = `www.${portDomain.toLowerCase()}`;
                if (wwwAdjustedDomain) {
                  const domainExistsB = configuredApps.hasDomain(wwwAdjustedDomain);
                  if (!domainExistsB) {
                    const configuredAppCustom = {
                      name: app.name,
                      appName: `${app.name}_${component.name}_${component.ports[i]}`,
                      domain: wwwAdjustedDomain,
                      port: component.ports[i],
                      ips: appIps,
                      isRdata: app.isRdata,
                      ...customConfigs[j],
                      timeout,
                    };
                    configuredApps.push(configuredAppCustom);
                  }
                }

                const testAdjustedDomain = `test.${portDomain.toLowerCase()}`;
                if (testAdjustedDomain) {
                  const domainExistsB = configuredApps.hasDomain(testAdjustedDomain);
                  if (!domainExistsB) {
                    const configuredAppCustom = {
                      name: app.name,
                      appName: `${app.name}_${component.name}_${component.ports[i]}`,
                      domain: testAdjustedDomain,
                      port: component.ports[i],
                      ips: appIps,
                      isRdata: app.isRdata,
                      ...customConfigs[j],
                      timeout,
                    };
                    configuredApps.push(configuredAppCustom);
                  }
                }
              }
            }
          }
        }
        j += 1;
      }
    }
    // push main domain
    for (let q = 0; q < app.compose.length; q += 1) {
      for (let w = 0; w < app.compose[q].ports.length; w += 1) {
        const mainDomainExists = configuredApps.hasDomain(domains[domains.length - 1]);
        if (!mainDomainExists) {
          const mainApp = {
            name: app.name,
            appName: `${app.name}_${app.compose[q].name}_${app.compose[q].ports[w]}`,
            domain: domains[domains.length - 1],
            port: app.compose[q].ports[w],
            ips: appIps,
            isRdata: app.isRdata,
            ...customConfigs[customConfigs.length - 1],
          };
          configuredApps.push(mainApp);
        }
      }
    }
  }
}

/**
 *
 * @param {Map<string, Object>} globalAppSpecs Pre filtered NonG Applications
 */
async function generateAndReplaceMainApplicationHaproxyConfig() {
  const startTime = process.hrtime.bigint();
  let appsProcessingTimeNs = 0;

  try {
    log.info('Non G Mode STARTED');

    // just use the map in the future
    const globalAppSpecs = nonGApps.values();

    // filter applications based on config
    const applicationSpecifications = getApplicationsToProcess(globalAppSpecs);

    // for every application do following
    // get name, ports
    // main application domain is name.app.domain, for every port we have name-port.app.domain
    // check and adjust dns record for missing domains
    // obtain certificate
    // add to renewal script
    // check if certificate exist
    // if all ok, add for creation of domain
    await createSSLDirectory();
    log.info('SSL directory checked');
    const appsOK = await processApplications(
      applicationSpecifications,
      myFDMnameORip,
      myIP,
    );
    // check appsOK against mandatoryApps
    let { mandatoryApps } = config;
    if (config.useSubset) {
      mandatoryApps = filterMandatoryApps(mandatoryApps);
    }
    for (const mandatoryApp of mandatoryApps) {
      const appExists = appsOK.find((app) => app.name === mandatoryApp);
      if (!appExists) {
        throw new Error(`Mandatory app ${mandatoryApp} does not exist. PANIC`);
      }
    }
    // continue with appsOK
    const configuredApps = createConfiguredApps();
    for (const app of appsOK) {
      const appStartTime = process.hrtime.bigint();

      log.info(`Configuring Non G App ${app.name}`);

      const appLocations = appsLocations.get(app.name) || [];

      let searchCount = 0;
      while (!appLocations.length && searchCount < 5) {
        log.info(`Application: ${app.name} not found in global locations... `
          + 'searching nodes');
        searchCount += 1;
        // eslint-disable-next-line no-await-in-loop
        const newLocations = await fluxService.getApplicationLocation(app.name);
        appLocations.push(...newLocations);
      }

      if (app.name === 'blockbookbitcoin') {
        appLocations.push({ ip: '[2001:41d0:d00:b800::20]:9130' });
        appLocations.push({ ip: '[2001:41d0:d00:b800::21]:9130' });
      }
      if (app.name === 'blockbooklitecoin') {
        appLocations.push({ ip: '[2001:41d0:d00:b800::24]:9134' });
        appLocations.push({ ip: '[2001:41d0:d00:b800::25]:9134' });
      }
      if (app.name === 'blockbookdogecoin') {
        appLocations.push({ ip: '[2001:41d0:d00:b800::36]:9138' });
        appLocations.push({ ip: '[2001:41d0:d00:b800::37]:9138' });
      }
      if (app.name === 'blockbookravencoin') {
        appLocations.push({ ip: '[2001:41d0:d00:b800::46]:9159' });
        appLocations.push({ ip: '[2001:41d0:d00:b800::47]:9159' });
      }
      if (app.name === 'blockbookbitcointestnet') {
        appLocations.push({ ip: '[2001:41d0:d00:b800::42]:19129' });
        appLocations.push({ ip: '[2001:41d0:d00:b800::43]:19129' });
      }
      if (app.name === 'blockbookbitcoinsignet') {
        appLocations.push({ ip: '[2001:41d0:d00:b800::97]:19120' });
        appLocations.push({ ip: '[2001:41d0:d00:b800::98]:19120' });
      }
      if (app.name === 'blockbookzcash') {
        appLocations.push({ ip: '[2001:41d0:d00:b800::26]:9132' });
        appLocations.push({ ip: '[2001:41d0:d00:b800::27]:9132' });
      }
      if (app.name === 'blockbookbitcoincash') {
        appLocations.push({ ip: '[2001:41d0:d00:b800::91]:9131' });
        appLocations.push({ ip: '[2001:41d0:d00:b800::92]:9131' });
      }
      if (appLocations.length > 0) {
        let appIps = [];
        app.isRdata = false;
        const applicationWithChecks = applicationChecks.applicationWithChecks(app);
        if (applicationWithChecks) {
          let promiseArray = [];
          for (const [i, location] of appLocations.entries()) {
            // run coded checks for app
            promiseArray.push(addAppIps(app, location.ip));
            if ((i + 1) % 10 === 0) {
              // eslint-disable-next-line no-await-in-loop
              await Promise.allSettled(promiseArray);
              promiseArray = [];
              if (app.name === 'explorer') {
                log.info(appIpsOnAppsChecks);
              }
              // eslint-disable-next-line no-loop-func
              appIpsOnAppsChecks.forEach((loc) => {
                appIps.push(loc);
              });
              appIpsOnAppsChecks = [];
            }
          }
          if (promiseArray.length > 0) {
            // eslint-disable-next-line no-await-in-loop
            await Promise.allSettled(promiseArray);
            promiseArray = [];
            if (app.name === 'explorer') {
              log.info(appIpsOnAppsChecks);
            }
            appIpsOnAppsChecks.forEach((loc) => {
              appIps.push(loc);
            });
            appIpsOnAppsChecks = [];
          }
          // as the application checks uses network, the responses can come in
          // a different order, so we sort the responses by ip address.
          serviceHelper.sortIPAddresses(appIps);
        } else if (
          app.compose
          && app.compose.find((comp) => comp.repotag.toLowerCase().includes('runonflux/shared-db'))
        ) {
          // app using sharedDB project
          app.isRdata = true;
          // Ordered before the cluster has its say, so the fallbacks below start
          // from a fixed order rather than from whatever the locations API
          // happened to return this time.
          appIps = orderBySeniority(appLocations.map((location) => location.ip), appLocations);
          const componentUsingSharedDB = app.compose.find((comp) => comp.repotag.toLowerCase().includes('runonflux/shared-db'));
          log.info(`sharedDBApps: Found app ${app.name} using sharedDB`);
          if (
            componentUsingSharedDB.ports
            && componentUsingSharedDB.ports.length > 0
          ) {
            const apiPort = componentUsingSharedDB.ports[
              componentUsingSharedDB.ports.length - 1
            ]; // it's the last port from the shareddb that is the api port
            let operatorClusterStatus = null;
            const httpTimeout = 5000;
            // eslint-disable-next-line no-await-in-loop
            for (const ip of appIps) {
              const url = `http://${ip.split(':')[0]}:${apiPort}/status`;
              log.info(
                `sharedDBApps: ${app.name} going to check operator status on url ${url}`,
              );
              // eslint-disable-next-line no-await-in-loop
              const operatorStatus = await serviceHelper
                .httpGetRequest(url, httpTimeout)
                .catch((error) => log.error(
                  `sharedDBApps: ${app.name} operatorStatus error: ${error}`,
                ));
              if (
                operatorStatus
                && operatorStatus.data
                && operatorStatus.data.status === 'OK'
              ) {
                operatorClusterStatus = operatorStatus.data.clusterStatus.map(
                  (cluster) => cluster.ip,
                );
                break;
              }
            }
            if (operatorClusterStatus) {
              appIps = orderByCluster(appIps, operatorClusterStatus, appLocations);
              log.info(`Application ${app.name} was setup as a sharedDBApps`);
            } else {
              // No operator could be reached, so the cluster cannot say who its
              // master is and this has to choose one. Oldest instance first: for
              // a replicated app it is the one most likely to hold the complete
              // data, and it is the same key FluxOS's own g: master election
              // uses (compareInstanceSeniority, runningSince ascending).
              //
              // This is a degraded path that has never actually ordered anything.
              // It compared `a.runningSince` and `a.ip` on elements that are bare
              // `ip:port` STRINGS - every field undefined, every comparison 0, a
              // stable sort left the arbitrary input order untouched. So when the
              // cluster was unreachable the write target was whatever the
              // locations API listed first that second.
              appIps = orderBySeniority(appIps, appLocations);
            }
            // lets remove db and operator from haproxy
            const componentUsingSharedDBIndex = app.compose.findIndex((comp) => comp.repotag.toLowerCase().includes('runonflux/shared-db'));
            const componentMySQLIndex = app.compose.findIndex((comp) => comp.repotag.toLowerCase().includes('mysql'));
            if (componentUsingSharedDBIndex >= 0) {
              app.compose[componentUsingSharedDBIndex].ports = app.compose[componentUsingSharedDBIndex].ports.slice(-1);
            }
            if (componentMySQLIndex >= 0) {
              app.compose.splice(componentMySQLIndex, 1);
            }
          } else if (
            (app.version <= 3 && app.containerData.includes('r:'))
            || (app.compose
              && app.compose.find((comp) => comp.containerData.includes('r:')))
          ) {
            // Same defect as the fallback above, and the same fix.
            app.isRdata = true;
            appIps = orderBySeniority(appIps, appLocations);
          }
        } else {
          // The branch most apps take. Order carries no meaning here - haproxy
          // spreads traffic over every server - but it has to be FIXED, because
          // the locations API returns the same instances in a different order
          // each call and the config is byte-compared to decide whether to
          // reload haproxy. Sorting by address is what the checked branch above
          // already does; this one simply never did it.
          appIps = serviceHelper.sortIPAddresses(appLocations.map((location) => location.ip));
        }
        if (app.name === 'explorer') {
          log.info(appIps);
        }
        if (config.mandatoryApps.includes(app.name) && appIps.length < 1) {
          throw new Error(`Application ${app.name} checks not ok. PANIC.`);
        }
        addConfigurations(configuredApps, app, appIps, false);
        log.info(
          `Non G Application ${app.name} with specific checks: ${applicationWithChecks} is OK. Proceeding to FDM`,
        );
      } else {
        log.warn(`Non G Application ${app.name} is excluded. Not running properly?`);
        if (config.mandatoryApps.includes(app.name)) {
          throw new Error(`Application ${app.name} is not running well PANIC.`);
        }
      }

      const elapsedNs = Number(process.hrtime.bigint() - appStartTime);
      const elapsedS = Math.round((elapsedNs / 1_000_000_000) * 100) / 100;
      appsProcessingTimeNs += elapsedNs;
      log.info(`Non G App: ${app.name}, Elapsed: ${elapsedS}`);
    }

    const elapsedAppsS = Math.round((appsProcessingTimeNs / 1_000_000_000) * 100) / 100;
    log.info(`Total Non G apps processing time. Elapsed: ${elapsedAppsS}`);

    if (configuredApps.length < 10) {
      throw new Error('PANIC PLEASE DEV HELP ME');
    }

    const configuredAppsList = configuredApps.list();
    const serializedApps = JSON.stringify(configuredAppsList);
    const lastSerializedApps = JSON.stringify(recentlyConfiguredApps);

    if (serializedApps === lastSerializedApps) {
      log.info('No changes in Non G Mode configuration detected');
      return;
    }

    let haproxyAppsConfig = [];
    recentlyConfiguredApps = configuredAppsList;
    nonGAppsInitialized = true;

    // if g apps haven't completed once - we don't update the config
    if (!recentlyConfiguredGApps.length) return;

    log.info('Changes in Non G Mode configuration detected');

    // we need to put always in same order to avoid. non g first g at end
    haproxyAppsConfig = configuredAppsList.concat(recentlyConfiguredGApps);

    log.info(
      `Non G Mode updating haproxy with length: ${haproxyAppsConfig.length}`,
    );
    await updateHaproxy(haproxyAppsConfig);
  } catch (error) {
    log.error(error);
  } finally {
    const elapsedNs = Number(process.hrtime.bigint() - startTime);
    const elapsedS = Math.round((elapsedNs / 1_000_000_000) * 100) / 100;
    log.info(`Non G Mode ENDED. Elapsed: ${elapsedS}s`);
  }
}

async function generateAndReplaceMainApplicationHaproxyGAppsConfig() {
  const sinceLast = monotonicMs() - lastGPassStartedAt;
  if (lastGPassStartedAt && sinceLast < G_PASS_MIN_INTERVAL_MS) {
    const waitMs = G_PASS_MIN_INTERVAL_MS - sinceLast;
    log.info(`G Mode holding ${Math.round(waitMs / 1000)}s - the previous pass started ${Math.round(sinceLast / 1000)}s ago and the nodes would answer from the same cache`);
    await serviceHelper.timeout(waitMs);
  }
  lastGPassStartedAt = monotonicMs();
  const startTime = process.hrtime.bigint();

  try {
    log.info('G Mode STARTED');

    const globalAppSpecs = gApps.values();

    // filter applications based on config
    const applicationSpecifications = getApplicationsToProcess(globalAppSpecs);

    // for every application do following
    // get name, ports
    // main application domain is name.app.domain, for every port we have name-port.app.domain
    // check and adjust dns record for missing domains
    // obtain certificate
    // add to renewal script
    // check if certificate exist
    // if all ok, add for creation of domain
    await createSSLDirectory();
    log.info('SSL directory checked');
    const appsOK = await processApplications(
      applicationSpecifications,
      myFDMnameORip,
      myIP,
    );

    // Locations first, and only for the apps that have none cached - 3 of 336 on
    // fdm-eu-1-03. The answer is written BACK to the cache, which the old shape
    // dropped: `appsLocations.get(name) || []` hands back a fresh array when the
    // key is absent, so nothing was ever stored and the search ran again every
    // pass, forever.
    const locationsForPass = new Map();
    const needSearch = [];
    for (const app of appsOK) {
      const cached = appsLocations.get(app.name);
      if (cached && cached.length) locationsForPass.set(app.name, cached);
      else needSearch.push(app);
    }
    if (needSearch.length) {
      const searched = await serviceHelper.runWithConcurrency(
        needSearch.map((app) => async () => {
          log.info(`Application: ${app.name} not found in global locations... searching nodes`);
          return [app.name, await fluxService.getApplicationLocation(app.name)];
        }),
        G_PASS_CONCURRENCY,
      );
      for (const result of searched) {
        if (result.status === 'fulfilled') {
          const [name, found] = result.value;
          if (found && found.length) {
            locationsForPass.set(name, found);
            appsLocations.set(name, found);
          }
        }
      }
    }

    const selected = await selectGPrimaries(appsOK, locationsForPass);

    // continue with appsOK
    const configuredApps = createConfiguredApps();
    for (const app of appsOK) {
      log.info(`Configuring ${app.name}`);

      const appLocations = locationsForPass.get(app.name) || [];

      if (appLocations.length > 0) {
        const appIps = [];

        // if its G data application, use just one IP
        const selectedIP = selected.get(app.name);
        if (selectedIP) {
          appIps.push(selectedIP);
          addConfigurations(configuredApps, app, appIps, true);
          log.info(
            `G Application ${app.name} is OK selected IP is ${selectedIP}. Proceeding to FDM`,
          );
        }

        if (config.mandatoryApps.includes(app.name) && appIps.length < 1) {
          throw new Error(`Application ${app.name} checks not ok. PANIC.`);
        }
      } else {
        log.warn(
          `G Application ${app.name} is excluded. Not running properly?`,
        );
        if (config.mandatoryApps.includes(app.name)) {
          throw new Error(`Application ${app.name} is not running well PANIC.`);
        }
      }
    }

    const configuredAppsList = configuredApps.list();
    const serializedApps = JSON.stringify(configuredAppsList);
    const lastSerializedApps = JSON.stringify(recentlyConfiguredGApps);

    if (serializedApps === lastSerializedApps) {
      log.info('No changes in G Mode configuration detected');
      return;
    }

    log.info('Changes in G Mode configuration detected');

    let haproxyAppsConfig = [];

    recentlyConfiguredGApps = configuredAppsList;
    gAppsInitialized = true;

    // if non g apps haven't completed once - we don't update the config
    if (!recentlyConfiguredApps.length) return;

    haproxyAppsConfig = recentlyConfiguredApps.concat(configuredAppsList);

    log.info(
      `G Mode updating haproxy with length: ${haproxyAppsConfig.length}`,
    );
    await updateHaproxy(haproxyAppsConfig);
  } catch (error) {
    log.error(error);
  } finally {
    const elapsedNs = Number(process.hrtime.bigint() - startTime);
    const elapsedS = Math.round((elapsedNs / 1_000_000_000) * 100) / 100;
    log.info(`G Mode ENDED. Elapsed: ${elapsedS}s`);
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
    // Collect all unique custom domains across all apps for a single parallel batch
    const domainSet = new Set();
    for (const appSpecs of applicationSpecifications) {
      const customDomains = getCustomDomains(appSpecs);
      customDomains.forEach((d) => domainSet.add(d));
    }
    const allCustomDomains = [...domainSet];
    let certsChanged = false;
    if (allCustomDomains.length) {
      log.info(`Processing ${allCustomDomains.length} unique custom domains from ${applicationSpecifications.length} apps`);
      const certOps = await executeCertificateOperations(
        allCustomDomains,
        DOMAIN_TYPE.CUSTOM,
        myFDMnameORip,
        myIP,
      );
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

/** Initiates application processing. Before the haproxy app config is generated,
 * it ensure that the app specs and permanent messages are populated. It then
 * runs
 * @returns {Promise<void>}
 */
async function startApplicationProcessing() {
  if (dataFetcher) return;

  // these are symlinked to the correct key / pem on every box
  dataFetcher = new FdmDataFetcher({
    keyPath: '/etc/ssl/private/fdm-arcane.key',
    certPath: '/etc/ssl/certs/fdm-arcane.pem',
    caPath: '/etc/ssl/certs/fdm-arcane-ca.pem',
    fluxApiBaseUrl: 'https://api.runonflux.io/',
    sasApiBaseUrl: 'https://10.100.0.170/api/',
  });

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
      handler('gApps', runQueue.gApps, generateAndReplaceMainApplicationHaproxyGAppsConfig),
      handler('nonGApps', runQueue.nonGApps, generateAndReplaceMainApplicationHaproxyConfig),
    ];

    await Promise.all(promises);
  };

  dataFetcher.on(
    'appSpecsUpdated',
    async (specs) => {
      unifiedAppsDomains = specs.appFqdns;
      nonGApps = specs.nonGApps;
      gApps = specs.gApps;
    },
  );

  dataFetcher.on('permMessagesUpdated', (permMessages) => {
    permanentMessages = permMessages;
  });

  dataFetcher.on('appsLocationsUpdated', locationsHandler);

  // We just run these once prior to the fetch loops ss the data is populated
  await dataFetcher.permMessageRunner();
  await dataFetcher.appSpecRunner();
  await dataFetcher.appsLocationsRunner();

  await locationsHandler();

  dataFetcher.startAppSpecLoop();
  dataFetcher.startPermMessagesLoop();
  dataFetcher.startAppsLocationsLoop();
}

// services run every 6 mins
function initializeServices() {
  myIP = ipService.localIP();
  console.log(`public IP: ${myIP}`);
  if (config.domainAppType === 'CNAME') {
    myFDMnameORip = config.fdmAppDomain;
  } else {
    myFDMnameORip = myIP;
  }
  if (myIP) {
    if (config.manageCertificateOnly) {
      if (!dataFetcher) {
        dataFetcher = new FdmDataFetcher({
          keyPath: '/etc/ssl/private/fdm-arcane.key',
          certPath: '/etc/ssl/certs/fdm-arcane.pem',
          caPath: '/etc/ssl/certs/fdm-arcane-ca.pem',
          fluxApiBaseUrl: 'https://api.runonflux.io/',
          sasApiBaseUrl: 'https://10.100.0.170/api/',
        });
      }
      obtainCertificatesMode();
      startCertRsync();
      log.info('FDM Certificate Service initialized.');
    } else if (
      config.mainDomain === config.cloudflare.domain
      && !config.cloudflare.manageapp
    ) {
      generateAndReplaceMainHaproxyConfig();
      log.info('Flux Main Node Domain Service initiated.');
    } else if (
      config.mainDomain === config.pDNS.domain
      && !config.pDNS.manageapp
    ) {
      generateAndReplaceMainHaproxyConfig();
      log.info('Flux Main Node Domain Service initiated.');
    } else if (
      config.mainDomain === config.cloudflare.domain
      && config.cloudflare.manageapp
      && !dataFetcher
    ) {
      // only runs on main FDM handles X.APP.runonflux.io. This only runs once
      // to add event listeners
      startApplicationProcessing();

      log.info('Flux Main Application Domain Service initiated.');
    } else if (
      config.mainDomain === config.pDNS.domain
      && config.pDNS.manageapp
      && !dataFetcher
    ) {
      // only runs on main FDM handles X.APP.runonflux.io. This only runs once
      startApplicationProcessing();
      log.info('Flux Main Application Domain Service initiated.');
    } else {
      log.info('CUSTOM DOMAIN SERVICE UNAVAILABLE');
    }
  } else {
    log.warn('Awaiting FDM IP address...');
    setTimeout(() => {
      initializeServices();
    }, 5 * 1000);
  }
}

async function start() {
  try {
    log.info('Initiating FDM API services...');
    initializeServices();
  } catch (e) {
    // restart service after 5 mins
    log.error(e);
    setTimeout(() => {
      start();
    }, 15 * 60 * 1000);
  }
}

function getConfiguredApps() {
  return {
    nonGApps: recentlyConfiguredApps,
    gApps: recentlyConfiguredGApps,
    nonGAppsInitialized,
    gAppsInitialized,
  };
}

// Exported for tests. selectIPforG's decision rests on module-level sticky state,
// and the ordering it enforces - a node RUNNING the app always outranks one that
// is merely holding it - is the property that makes the held fallback safe to
// deploy ahead of the FluxOS release that serves /apps/heldcomponents.
function getGStickyIp(appName) {
  return mapOfNamesIps[appName];
}

function setGStickyState(appName, ip, lastHealthyMs) {
  mapOfNamesIps[appName] = ip;
  if (lastHealthyMs === undefined) {
    delete mapOfNamesIpsLastHealthy[appName];
  } else {
    mapOfNamesIpsLastHealthy[appName] = lastHealthyMs;
  }
}

function resetGStickyState(appName) {
  delete mapOfNamesIps[appName];
  delete mapOfNamesIpsLastHealthy[appName];
  delete mapOfNamesIpsLastHeld[appName];
}

module.exports = {
  start,
  getConfiguredApps,
  selectIPforG,
  selectGPrimaries,
  orderBySeniority,
  orderByCluster,
  monotonicMs,
  getGStickyIp,
  setGStickyState,
  resetGStickyState,
};

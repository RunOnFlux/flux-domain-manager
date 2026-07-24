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
const { PublishGuard } = require('./haproxy/completeness');
const { resolveAppLocations, runPerApp } = require('./haproxy/appCycle');
const { ConditionLog } = require('./conditionLog');
const specLibs = require('./flux/specLibs');
const { startCertRsync } = require('./rsync');
const serviceHelper = require('./serviceHelper');

const { FdmDataFetcher } = require('./flux/dataFetcher');

let myIP = null;

const ownership = new DomainOwnershipRegistry();
// The active-standby instance currently serving each app, and when it was last seen
// healthy. An instance is `{ ip, replica }` — for a loose (unnamed) instance that is just
// its node, which is every app in the wild today.
const mapOfNamesInstances = {};
const mapOfNamesInstancesLastHealthy = {}; // timestamp of last successful health check per app

// Two instances are the same when they are the same replica on the same node. A node
// hosting co-located replicas holds several distinct instances of one app.
const sameInstance = (a, b) => Boolean(a) && Boolean(b)
  && a.ip === b.ip && (a.replica || null) === (b.replica || null);
const describeInstance = (instance) => (
  instance.replica ? `${instance.ip} (replica ${instance.replica})` : instance.ip);
const ACTIVE_STANDBY_HEALTH_RETRY_COUNT = 3;
const ACTIVE_STANDBY_HEALTH_RETRY_DELAY_MS = 3000;
const ACTIVE_STANDBY_UNHEALTHY_THRESHOLD_MS = 90 * 1000; // 90 seconds before switching away from sticky IP
let recentlyConfiguredActiveActiveRouteConfigs = [];
let recentlyConfiguredActiveStandbyRouteConfigs = [];
let activeActiveAppsInitialized = false;
let activeStandbyAppsInitialized = false;

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

async function checkAppRunningWithRetries(instance, appName, retries = ACTIVE_STANDBY_HEALTH_RETRY_COUNT) {
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop
    const isOk = await applicationChecks.checkAppRunning(instance.ip, appName, instance.replica);
    if (isOk) {
      return true;
    }
    if (attempt < retries) {
      log.info(`Active-Standby App ${appName} health check attempt ${attempt}/${retries} failed for ${describeInstance(instance)}, retrying...`);
      // eslint-disable-next-line no-await-in-loop
      await serviceHelper.timeout(ACTIVE_STANDBY_HEALTH_RETRY_DELAY_MS);
    }
  }
  return false;
}

/**
 * Choose the ONE instance an active-standby app serves from. The others are warm
 * standbys sharing state through syncthing, so two of them serving at once is the
 * corruption this mode exists to prevent.
 *
 * The unit of selection is an instance — `{ ip, replica }` — not a node. A node can host
 * several co-located replicas of the same app, so selecting a node would leave every
 * replica on it in rotation, and the health check would answer "is the app alive on that
 * node" when the question is "is THIS replica alive". Both follow the instance.
 *
 * A loose (unnamed) instance is its node, so for every legacy app this is exactly the
 * historical per-ip behaviour: same sticky identity, same lowest-digit-sum ordering, same
 * unhealthy grace period.
 *
 * @param {Array<{ip: string, replica: (string|null)}>} instances live, non-draining
 * @param {Object} app
 * @param {Function} [probe] health check, injectable for tests
 * @returns {Promise<{ip: string, replica: (string|null)}|null>}
 */
async function selectActiveInstance(instances, app, probe = checkAppRunningWithRetries) {
  if (!instances || !instances.length) return null;
  // choose the ip address whose sum of digits is the lowest
  const lowestDigitSumIp = selectLowestDigitSumIp(instances.map((i) => i.ip));

  // Use the sticky instance if it is still placed
  const sticky = mapOfNamesInstances[app.name];
  const stickyPlaced = sticky && instances.find((i) => sameInstance(i, sticky));
  if (stickyPlaced) {
    // Sticky instance still exists in locations - health check it with retries
    const isOk = await probe(stickyPlaced, app.name);
    if (isOk) {
      mapOfNamesInstancesLastHealthy[app.name] = Date.now();
      return stickyPlaced;
    }
    // Sticky instance failed all retries - check if we should still keep it
    // based on how recently it was last seen healthy
    const lastHealthy = mapOfNamesInstancesLastHealthy[app.name] || 0;
    const timeSinceHealthy = Date.now() - lastHealthy;
    if (lastHealthy > 0 && timeSinceHealthy < ACTIVE_STANDBY_UNHEALTHY_THRESHOLD_MS) {
      log.warn(
        `Active-Standby App ${app.name} sticky instance ${describeInstance(stickyPlaced)} failed health check but was healthy ${Math.round(timeSinceHealthy / 1000)}s ago (threshold: ${ACTIVE_STANDBY_UNHEALTHY_THRESHOLD_MS / 1000}s), keeping it`,
      );
      return stickyPlaced;
    }
    log.warn(
      `Active-Standby App ${app.name} sticky instance ${describeInstance(stickyPlaced)} failed health check for >${ACTIVE_STANDBY_UNHEALTHY_THRESHOLD_MS / 1000}s, selecting a new one`,
    );
  }

  // No valid sticky instance - select from those available, lowest digit sum first
  const candidates = sticky
    ? instances.filter((i) => !sameInstance(i, sticky))
    : [...instances];
  // Put the lowest-digit-sum node first, then the rest; co-located replicas of the same
  // node break the tie on replica name so the choice is deterministic across directors.
  candidates.sort((a, b) => {
    if (a.ip === lowestDigitSumIp && b.ip !== lowestDigitSumIp) return -1;
    if (b.ip === lowestDigitSumIp && a.ip !== lowestDigitSumIp) return 1;
    if (a.ip === b.ip) return String(a.replica || '').localeCompare(String(b.replica || ''));
    return 0;
  });

  // eslint-disable-next-line no-restricted-syntax
  for (const candidate of candidates) {
    // eslint-disable-next-line no-await-in-loop
    const isOk = await probe(candidate, app.name);
    if (isOk) {
      mapOfNamesInstances[app.name] = candidate;
      mapOfNamesInstancesLastHealthy[app.name] = Date.now();
      return candidate;
    }
  }
  return null;
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
    const successRestart = await haproxyTemplate.restartProxy(dataToWrite);
    if (!successRestart) {
      throw new Error('Invalid HAPROXY Config File!');
    }
  } finally {
    updateHaproxyRunning = false;
  }
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

// One guard per loop, each remembering the size of the last config it published.
const activeActiveGuard = new PublishGuard('Active-Active', config.haproxyRouting.publishGuard);
const activeStandbyGuard = new PublishGuard('Active-Standby', config.haproxyRouting.publishGuard);

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
function sharedDbApiPort(deployment) {
  const images = config.sharedDbRouting.components.map((rule) => rule.image);
  const isOperator = (name) => {
    const image = (deployment.components[name]?.image || '').toLowerCase();
    return images.some((match) => image.includes(match));
  };
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
  } else if (sharedDbApiPort(deployment)) {
    // shared-db: order backends by the operator's live cluster status, primary first, so
    // writes land on the node that can take them. Which ports reach the load balancer is
    // decided in effectiveRoutes, not here — this branch only orders.
    appIps = live.map((location) => location.ip);
    const apiPort = sharedDbApiPort(deployment);
    log.info(`sharedDBApps: Found app ${app.name} using sharedDB`);
    let operatorClusterStatus = null;
    const httpTimeout = 5000;
    // eslint-disable-next-line no-restricted-syntax
    for (const ip of appIps) {
      const url = `http://${ip.split(':')[0]}:${apiPort}/status`;
      log.info(`sharedDBApps: ${app.name} going to check operator status on url ${url}`);
      // eslint-disable-next-line no-await-in-loop
      const operatorStatus = await serviceHelper.httpGetRequest(url, httpTimeout)
        .catch((error) => log.error(`sharedDBApps: ${app.name} operatorStatus error: ${error}`));
      if (operatorStatus && operatorStatus.data && operatorStatus.data.status === 'OK') {
        operatorClusterStatus = operatorStatus.data.clusterStatus.map((cluster) => cluster.ip);
        break;
      }
    }
    if (operatorClusterStatus) {
      appIps.sort((a, b) => operatorClusterStatus.indexOf(a) - operatorClusterStatus.indexOf(b));
      log.info(`Application ${app.name} was setup as a sharedDBApps`);
    }
  } else {
    appIps = live.map((location) => location.ip);
  }

  // syncFirst version-blind, from the typed sync mode: legacy `r:` container data and a
  // v9 sync declaration both resolve to requiresSyncBeforeStart.
  // eslint-disable-next-line no-param-reassign
  app.syncFirst = Object.values(deployment.components).some((c) => c.requiresSyncBeforeStart());
  return { appIps, drainingIps, backends: toBackends(appIps, drainingIps, appLocations) };
}

/**
 *
 * @param {Map<string, Object>} globalAppSpecs Pre filtered active-active applications
 */
async function generateActiveActiveHaproxyConfig() {
  const startTime = process.hrtime.bigint();
  let appsProcessingTimeNs = 0;

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
    const routeConfigs = []; // object of domain, port, ips for backend and syncFirst
    await runPerApp(applicationSpecifications, 'Active-Active', async (app) => {
      const appStartTime = process.hrtime.bigint();

      log.info(`Configuring Active-Active App ${app.name}`);

      // eslint-disable-next-line no-await-in-loop
      const appLocations = await resolveAppLocations({
        appName: app.name,
        known: appsLocations,
        fetchLocations: fluxService.getApplicationLocation,
      });

      if (appLocations.length > 0) {
        const applicationWithChecks = applicationChecks.applicationWithChecks(app);
        const { appIps, backends } = await resolveBackends(app, appLocations);
        unhealthyApps.report(app.name, appIps.length < 1, () => `Active-Active Application ${app.name} has no healthy instances`);
        await appendRouteConfigs(routeConfigs, app, backends, false);
        log.info(
          `Active-Active Application ${app.name} with specific checks: ${applicationWithChecks} is OK. Proceeding to FDM`,
        );
      } else {
        unhealthyApps.report(app.name, true, () => `Active-Active Application ${app.name} has no locations at all`);
      }

      const elapsedNs = Number(process.hrtime.bigint() - appStartTime);
      const elapsedS = Math.round((elapsedNs / 1_000_000_000) * 100) / 100;
      appsProcessingTimeNs += elapsedNs;
      log.info(`Active-Active App: ${app.name}, Elapsed: ${elapsedS}`);
    });

    const elapsedAppsS = Math.round((appsProcessingTimeNs / 1_000_000_000) * 100) / 100;
    log.info(`Total Active-Active apps processing time. Elapsed: ${elapsedAppsS}`);

    if (!activeActiveGuard.allows(routeConfigs.length)) {
      return;
    }

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

    if (outcome.action === 'unchanged') {
      log.info('No changes in Active-Active Mode configuration detected');
      return;
    }
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
  const startTime = process.hrtime.bigint();

  try {
    log.info('Active-Standby Mode STARTED');

    const globalAppSpecs = activeStandbyApps.values();

    // filter applications based on config
    const applicationSpecifications = getApplicationsToProcess(globalAppSpecs);

    // The directory haproxy loads its certificates from. The certificate process fills
    // it and rsyncs it across the group; this loop only needs it to exist.
    await createSSLDirectory();
    log.info('SSL directory checked');
    const routeConfigs = []; // object of domain, port, ips for backend and syncFirst
    await runPerApp(applicationSpecifications, 'Active-Standby', async (app) => {
      log.info(`Configuring ${app.name}`);

      // eslint-disable-next-line no-await-in-loop
      const appLocations = await resolveAppLocations({
        appName: app.name,
        known: appsLocations,
        fetchLocations: fluxService.getApplicationLocation,
      });

      if (appLocations.length > 0) {
        // Active-standby routes to a single live INSTANCE — one replica on one node, not
        // a whole node, since a node may host co-located replicas and only one of them
        // may serve. Draining instances are dropped from selection first, so a
        // shutting-down one is never chosen, then rendered in maintenance below.
        const liveInstances = appLocations
          .filter((l) => !isDraining(l))
          .map((l) => ({ ip: l.ip, replica: l.replica || null }));
        const draining = appLocations
          .filter(isDraining)
          .map((l) => ({ ip: l.ip, replica: l.replica || null, draining: true }));
        logDraining(app.name, draining.map((b) => b.ip));
        // eslint-disable-next-line no-await-in-loop
        const selected = await selectActiveInstance(liveInstances, app);
        unhealthyApps.report(app.name, !selected, () => `Active-Standby Application ${app.name} has no instance fit to serve`);
        if (selected) {
          // Exactly the selected instance goes into rotation. Its co-located siblings are
          // standbys and must not appear as servers, or the single-writer guarantee is
          // gone the moment haproxy balances between them.
          const backends = [{ ...selected, draining: false }, ...draining];
          // eslint-disable-next-line no-await-in-loop
          await appendRouteConfigs(routeConfigs, app, backends, true);
          log.info(
            `Active-Standby Application ${app.name} is OK selected instance is ${describeInstance(selected)}. Proceeding to FDM`,
          );
        }
      } else {
        unhealthyApps.report(app.name, true, () => `Active-Standby Application ${app.name} has no locations at all`);
      }
    });

    if (!activeStandbyGuard.allows(routeConfigs.length)) {
      return;
    }

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

    if (outcome.action === 'unchanged') {
      log.info('No changes in Active-Standby Mode configuration detected');
      return;
    }
    recentlyConfiguredActiveStandbyRouteConfigs = outcome.remember;
  } catch (error) {
    log.error(error);
  } finally {
    const elapsedNs = Number(process.hrtime.bigint() - startTime);
    const elapsedS = Math.round((elapsedNs / 1_000_000_000) * 100) / 100;
    log.info(`Active-Standby Mode ENDED. Elapsed: ${elapsedS}s`);
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
    specDecrypt: config.specDecrypt,
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
      handler('activeStandbyApps', runQueue.activeStandbyApps, generateActiveStandbyHaproxyConfig),
      handler('activeActiveApps', runQueue.activeActiveApps, generateActiveActiveHaproxyConfig),
    ];

    await Promise.all(promises);
  };

  dataFetcher.on(
    'appSpecsUpdated',
    async (specs) => {
      ownership.setAppDomains(specs.appFqdns);
      activeActiveApps = specs.activeActiveApps;
      activeStandbyApps = specs.activeStandbyApps;
    },
  );

  dataFetcher.on('permMessagesUpdated', (permMessages) => {
    ownership.setPermanentMessages(permMessages);
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
  if (myIP) {
    if (config.manageCertificateOnly) {
      if (!dataFetcher) {
        dataFetcher = new FdmDataFetcher({
          keyPath: '/etc/ssl/private/fdm-arcane.key',
          certPath: '/etc/ssl/certs/fdm-arcane.pem',
          caPath: '/etc/ssl/certs/fdm-arcane-ca.pem',
          fluxApiBaseUrl: 'https://api.runonflux.io/',
          specDecrypt: config.specDecrypt,
        });
      }
      obtainCertificatesMode();
      startCertRsync();
      log.info('FDM Certificate Service initialized.');
    } else if (!config.manageApps) {
      generateAndReplaceMainHaproxyConfig();
      log.info('Flux Main Node Domain Service initiated.');
    } else if (!dataFetcher) {
      // only runs on main FDM handles X.APP.runonflux.io. This only runs once
      // to add event listeners
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
    ipService.start();
    applicationChecks.startBlockheightRefresh();
    initializeServices();
  } catch (e) {
    // restart service after 5 mins
    log.error(e);
    setTimeout(() => {
      start();
    }, 15 * 60 * 1000);
  }
}

function getRouteConfigs() {
  return {
    activeActiveRouteConfigs: recentlyConfiguredActiveActiveRouteConfigs,
    activeStandbyRouteConfigs: recentlyConfiguredActiveStandbyRouteConfigs,
    activeActiveAppsInitialized,
    activeStandbyAppsInitialized,
  };
}

module.exports = {
  start,
  getRouteConfigs,
  resolveBackends,
  selectActiveInstance,
};

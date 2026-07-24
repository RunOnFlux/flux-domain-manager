/* eslint-disable no-unused-vars */
const config = require('config');
const httpClients = require('../httpClients');
const log = require('../../lib/log');
const { createAppCountReference } = require('../../lib/appCountReference');

const timeout = 5456;
let currentFluxBlockheight = 1968478;
// MAIN
async function checkLoginPhrase(ip, port) {
  try {
    const url = `http://${ip}:${port}/id/loginphrase`;
    const response = await httpClients.nodeChecks.get(url, { timeout });
    if (response.data.status === 'success') {
      return true;
    }
    log.info(`Function checkLoginPhrase false for ip ${ip}`);
    return false;
  } catch (error) {
    log.info(`Function checkLoginPhrase failed for ip ${ip}`);
    return false;
  }
}

async function isCommunicationOK(ip, port) {
  try {
    const urlA = `http://${ip}:${port}/flux/connectedpeersinfo`;
    const urlB = `http://${ip}:${port}/flux/incomingconnectionsinfo`;
    const responseA = await httpClients.nodeChecks.get(urlA, { timeout });
    if (responseA.data.data.length > 8) {
      const responseB = await httpClients.nodeChecks.get(urlB, { timeout });
      if (responseB.data.data.length > 4) {
        return true;
      }
    }
    log.info(`Function isCommunicationOK false for ip ${ip}`);
    return false;
  } catch (error) {
    log.info(`Function isCommunicationOK failed for ip ${ip}`);
    return false;
  }
}

async function isHomeOK(ip, port) {
  try {
    const url = `http://${ip}:${port}`;
    const response = await httpClients.nodeChecks.get(url, { timeout });
    if (/^<!doctype html>\s*<html/i.test(response.data)) {
      return true;
    }
    log.info(`Function isHomeOK false for ip ${ip}`);
    return false;
  } catch (error) {
    log.info(`Function isHomeOK failed for ip ${ip}`);
    return false;
  }
}

/**
 * Check if semantic version is bigger or equal to minimum version
 * @param {string} version Version to check
 * @param {string} minimumVersion minimum version that version must meet
 * @returns {boolean} True if version is equal or higher to minimum version otherwise false.
 */
function minVersionSatisfy(version, minimumVersion) {
  const splittedVersion = version.split('.');
  const major = Number(splittedVersion[0]);
  const minor = Number(splittedVersion[1]);
  const patch = Number(splittedVersion[2]);

  const splittedVersionMinimum = minimumVersion.split('.');
  const majorMinimum = Number(splittedVersionMinimum[0]);
  const minorMinimum = Number(splittedVersionMinimum[1]);
  const patchMinimum = Number(splittedVersionMinimum[2]);
  if (major < majorMinimum) {
    return false;
  }
  if (major > majorMinimum) {
    return true;
  }
  if (minor < minorMinimum) {
    return false;
  }
  if (minor > minorMinimum) {
    return true;
  }
  if (patch < patchMinimum) {
    return false;
  }
  return true;
}

async function isUptimeOK(ip, port) {
  try {
    const url = `http://${ip}:${port}/flux/uptime`;
    const response = await httpClients.nodeChecks.get(url, { timeout });
    if (response.data.data > 60) {
      return true;
    }
    log.info(`Function isUptimeOK false for ip ${ip}`);
    return false;
  } catch (error) {
    log.info(`Function isUptimeOK failed for ip ${ip}`);
    return false;
  }
}

async function isVersionOK(ip, port) {
  try {
    const url = `http://${ip}:${port}/flux/info`;
    const response = await httpClients.nodeChecks.get(url, { timeout });
    const { version } = response.data.data.flux;
    if (minVersionSatisfy(version, '8.18.0')) {
      if (response.data.data.flux.development === 'false' || !response.data.data.flux.development) {
        return true;
      }
    }
    log.info(`Function isVersionOK false for ip ${ip}`);
    return false;
  } catch (error) {
    log.info(`Function isVersionOK failed for ip ${ip}`);
    return false;
  }
}

async function isArcaneOS(ip, port) {
  try {
    const url = `http://${ip}:${port}/flux/isarcaneos`;
    const response = await httpClients.nodeChecks.get(url, { timeout });
    if (response.data.data) {
      return true;
    }
    return false;
  } catch (error) {
    return false;
  }
}

async function isSyncedOK(ip, port) {
  try {
    const url = `http://${ip}:${port}/explorer/scannedheight`;
    const response = await httpClients.nodeChecks.get(url, { timeout });
    const height = response.data.data.generalScannedHeight;
    if (height + 3 >= currentFluxBlockheight) {
      return true;
    }
    log.info(`Function isSyncedOK false for ip ${ip}`);
    return false;
  } catch (error) {
    log.info(`Function isSyncedOK failed for ip ${ip}`);
    return false;
  }
}

async function isDaemonSyncedOK(ip, port) {
  try {
    const url = `http://${ip}:${port}/daemon/getblockchaininfo`;
    const response = await httpClients.nodeChecks.get(url, { timeout });
    if (response.data.data.blocks + 10 >= response.data.data.headers) {
      return true;
    }
    log.info(`Function isDaemonSyncedOK false for ip ${ip}`);
    return false;
  } catch (error) {
    log.info(`Function isDaemonSyncedOK failed for ip ${ip}`);
    return false;
  }
}

const appCountReference = createAppCountReference(config.guards.mainNode.windowMs);

/**
 * Whether a node's app registry looks complete: it lists at least one app, and
 * its count is within `maxDeviationRatio` of the median count across the nodes
 * checked in the last `windowMs`.
 *
 * Warm-up: until `minReported` distinct nodes have reported within the window there
 * is no median to judge by, so every node is refused. Its count is still recorded,
 * so the median builds up as nodes are checked. This happens after an FDM restart
 * and whenever fewer than `minReported` nodes reach this check within the window.
 *
 * @param {string} ip
 * @param {string|number} port
 * @param {Object} [options]
 * @param {number} [options.now] monotonic ms
 * @param {Object} [options.reference] from createAppCountReference; defaults to the one all main node checks share
 * @returns {Promise<boolean>}
 */
async function hasManyApps(ip, port, {
  now = Number(process.hrtime.bigint() / 1_000_000n),
  reference = appCountReference,
} = {}) {
  try {
    const url = `http://${ip}:${port}/apps/globalappsspecifications`;
    const response = await httpClients.nodeChecks.get(url, { timeout });
    const apps = response.data.data;
    if (!Array.isArray(apps) || apps.length === 0) {
      log.info(`Function hasManyApps false for ip ${ip}: no app list`);
      return false;
    }
    const { minReported, maxDeviationRatio } = config.guards.mainNode;
    const { median, nodes } = reference.observe(`${ip}:${port}`, apps.length, now);
    if (nodes < minReported) {
      log.info(`Function hasManyApps false for ip ${ip}: ${apps.length} apps, only ${nodes} nodes reported`);
      return false;
    }
    if (apps.length < median * (1 - maxDeviationRatio) || apps.length > median * (1 + maxDeviationRatio)) {
      log.info(`Function hasManyApps false for ip ${ip}: ${apps.length} apps, median ${median} across ${nodes} nodes`);
      return false;
    }
    return true;
  } catch (error) {
    log.info(`Function hasManyApps failed for ip ${ip}`);
    return false;
  }
}

async function hasManyMessages(ip, port) {
  try {
    const url = `http://${ip}:${port}/apps/hashes`;
    const response = await httpClients.nodeChecks.get(url, { timeout });
    const appsAmount = response.data.data.length;
    if (appsAmount > 48000) {
      const messageFalse = response.data.data.filter((a) => a.message === false);
      if (messageFalse.length < 100) {
        return true;
      }
    }
    log.info(`Function hasManyMessages false for ip ${ip}`);
    return false;
  } catch (error) {
    log.info(`Function hasManyMessages failed for ip ${ip}`);
    return false;
  }
}

async function checkMainFlux(ip, port = 16127) {
  try {
    console.log(`Checking ${ip}:${port}`);
    const isArcane = await isArcaneOS(ip, port);
    console.log(`isArcane: ${isArcane}`);
    if (isArcane) {
      const uptimeOK = await isUptimeOK(ip, port);
      console.log(`uptimeOK: ${uptimeOK}`);
      if (uptimeOK) {
        // eslint-disable-next-line no-await-in-loop
        const versionOK = await isVersionOK(ip, port);
        console.log(`versionOK: ${versionOK}`);
        if (versionOK) {
          // eslint-disable-next-line no-await-in-loop
          const loginPhraseOK = await checkLoginPhrase(ip, port);
          console.log(`loginPhraseOK: ${loginPhraseOK}`);
          if (loginPhraseOK) {
            // eslint-disable-next-line no-await-in-loop
            const communicationOK = await isCommunicationOK(ip, port);
            console.log(`communicationOK: ${communicationOK}`);
            if (communicationOK) {
              const isSynced = await isSyncedOK(ip, port);
              console.log(`isSynced: ${isSynced}`);
              if (isSynced) {
                const isDaemonSynced = await isDaemonSyncedOK(ip, port);
                console.log(`isDaemonSynced: ${isDaemonSynced}`);
                if (isDaemonSynced) {
                  const hasApps = await hasManyApps(ip, port);
                  console.log(`hasApps: ${hasApps}`);
                  if (hasApps) {
                    const hasMessages = await hasManyMessages(ip, port);
                    console.log(`hasMessages: ${hasMessages}`);
                    if (hasMessages) {
                      // eslint-disable-next-line no-await-in-loop
                      const uiOK = await isHomeOK(ip, +port - 1);
                      console.log(`uiOK: ${uiOK}`);
                      if (uiOK) {
                        console.log(`${ip}:${port} is OK`);
                        return true;
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
    return false;
  } catch (error) {
    console.log(error);
    return false;
  }
}

// POLKADOT

async function checkALPHexplorer(ip, port) {
  try {
    log.info(`Checking ALPH explorer on: http://${ip}:${port}/blocks`);
    const websiteResponse = await httpClients.nodeChecks.get(`http://${ip}:${port}/blocks`, { timeout: 14888 });
    log.info('Response');
    log.info(websiteResponse.data);
    log.info(websiteResponse.data.blocks[0]);
    const minTime = new Date().getTime() - 2 * 60 * 60 * 1000;
    if (websiteResponse.data.blocks[0].timestamp > minTime) {
      return true;
    }
    return false;
  } catch (error) {
    log.info(`Failed to check ALPH explorer: ${error.message}`);
    return false;
  }
}

async function extendedInsightTest(url, blockUlr, txUrl) {
  const response = await httpClients.nodeChecks.get(url, { timeout: 8888 });
  const blockUrlAdjusted = blockUlr + response.data.blocks[0].hash;
  const responseB = await httpClients.nodeChecks.get(blockUrlAdjusted, { timeout: 8888 });
  const { txid } = responseB.data.txs[0];
  const adjustedUrlTx = txUrl + txid;
  const responseC = await httpClients.nodeChecks.get(adjustedUrlTx, { timeout: 8888 });
  if (responseC.data.confirmations < -2) {
    return false;
  }
  return true;
}

async function checkFluxExplorer(ip, port) {
  try {
    const response = await httpClients.nodeChecks.get(`http://${ip}:${port}/api/addr/t3c51GjrkUg7pUiS8bzNdTnW2hD25egWUih`, { timeout: 8888 });
    const responseB = await httpClients.nodeChecks.get(`http://${ip}:${port}/api/sync`, { timeout: 8888 });
    const responseC = await httpClients.nodeChecks.get(`http://${ip}:${port}/api/circulation`, { timeout: 8888 });
    const responseD = await httpClients.nodeChecks.get(`http://${ip}:${port}/api/status`, { timeout: 8888 });
    // eslint-disable-next-line no-use-before-define
    if (response.data.transactions.length > 0 && responseB.data.blockChainHeight >= currentFluxBlockheight && responseC.data.circulationsupply > 389000000 && responseD.data.info.version >= 8000050) {
      const urls = [`http://${ip}:${port}/api/blocks?limit=1`, `http://${ip}:${port}/api/txs/?block=`, `http://${ip}:${port}/api/tx/`];
      const result = await extendedInsightTest(urls[0], urls[1], urls[2]);
      if (result) {
        return true;
      }
    }
    return false;
  } catch (error) {
    return false;
  }
}

async function generalWebsiteCheck(ip, port, timeOut = 2500, appname) {
  try {
    const websiteResponse = await httpClients.nodeChecks.get(`http://${ip}:${port}`, { timeout: timeOut });
    if (appname.startsWith('themok')) {
      log.error(websiteResponse);
    }
    if (websiteResponse.data.includes('<html')) {
      return true;
    }
    log.error(websiteResponse.data);
    return false;
  } catch (error) {
    log.error(error);
    if (appname.startsWith('themok')) {
      log.error(error);
    }
    return false;
  }
}

const BLOCKBOOK_MAX_BLOCK_AGE_MS = 3 * 60 * 60 * 1000;
// How far blockbook's own index may trail the backend daemon and still count as current.
const BLOCKBOOK_MAX_INDEX_LAG = 100;

// The app name carries its coin: blockbookdogecoin, and blockbookbitcoincash23344 for a
// second deployment of one. The reference entry for that coin is optional — see
// isBlockBookFresh.
function blockBookCoin(appsname) {
  return appsname.replace('blockbook', '').replace(/\d+/g, '');
}

// The reference table off the blockbook rule, so a direct call needs no wiring. The
// dispatch passes rule.coins instead.
function blockBookCoins() {
  const rule = config.appChecks.checks.find((r) => r.probe === 'blockBook');
  return (rule && rule.coins) || {};
}

// Is this instance's index current? Answerable from the instance alone, with no per-coin
// reference: blockbook must have caught up with the daemon it indexes, and the chain tip
// it reports must be recent. An instance that has never synced reports bestHeight 0 and a
// last block weeks old while still claiming inSync, which is why its own flag is not
// consulted.
function isBlockBookFresh(info) {
  const { bestHeight, lastBlockTime } = info.blockbook;
  const lagOK = bestHeight > info.backend.blocks - BLOCKBOOK_MAX_INDEX_LAG;
  const age = Date.now() - new Date(lastBlockTime).getTime();
  return lagOK && age < BLOCKBOOK_MAX_BLOCK_AGE_MS;
}

// Does the address index answer consistently? The page of txids returned has to agree
// with the totals blockbook reports for that address, which a partially built index does
// not manage.
function hasConsistentAddressIndex(addr) {
  if (!addr.txids.length) return false;
  if (addr.txs <= 50) return addr.txids.length === addr.txs;
  if (addr.totalPages > addr.page) return addr.txids.length >= 50;
  return addr.txids.length === addr.txs % 50;
}

// `coins` carries the per-coin reference data — a known address and a height the chain is
// long past. It is deliberately optional: a coin with no entry is still checked for
// freshness rather than refused outright. Reading a missing coin out of a positional list
// used to yield index -1, so the address became `undefined` and every height comparison
// was `> undefined`, and the app could never pass however healthy it was — silently, since
// nothing distinguished it from a genuinely stale node.
async function checkBlockBook(ip, port, appsname, coins = blockBookCoins()) {
  try {
    const coin = blockBookCoin(appsname);
    const reference = coins[coin] || null;
    // Blockbook is addressed over https when the node gave us an IPv6 literal.
    const overIPv6 = ip.includes(':');
    const get = async (path) => {
      const response = overIPv6
        ? await httpClients.nodeChecksSelfSigned.get(`https://${ip}:${port}${path}`, { timeout })
        : await httpClients.nodeChecks.get(`http://${ip}:${port}${path}`, { timeout: 5000 });
      return response.data;
    };

    const info = await get('/api');

    if (coin === 'flux' && info.backend.version !== 'zebra' && +info.backend.version < 8000050) { // consider zebra always valid
      return false;
    }
    if (!isBlockBookFresh(info)) {
      log.error(`Bad IP ${ip}:${port} blockbook ${appsname}`);
      return false;
    }
    if (!reference) {
      log.warn(`blockbook ${appsname}: no reference data for coin "${coin}", checked for freshness only`);
      return true;
    }
    if (info.blockbook.bestHeight <= reference.minHeight || info.backend.blocks <= reference.minHeight) {
      log.error(`Bad IP ${ip}:${port} blockbook ${appsname}`);
      return false;
    }

    const addr = await get(`/api/v2/address/${reference.address}?pageSize=50`);
    if (hasConsistentAddressIndex(addr)) {
      return true;
    }
    log.error(`Bad IP ${ip}:${port} blockbook ${appsname}`);
    return false;
  } catch (error) {
    log.error(`Error checking blockbook endpoint: ${ip}:${port} ${error.message}`);
    return false;
  }
}

/**
 * One JSON-RPC 2.0 call; the result, or a throw for a transport or RPC error.
 * @param {string} url
 * @param {string} method
 * @returns {Promise<unknown>}
 */
async function jsonRpc(url, method) {
  const response = await httpClients.nodeChecks.post(
    url,
    {
      jsonrpc: '2.0', id: 1, method, params: [],
    },
    { timeout: 10_000, headers: { 'Content-Type': 'application/json' } },
  );
  if (response.data.error) throw new Error(response.data.error.message);
  return response.data.result;
}

async function checkEthers(ip, port, providerURL, cmd) {
  try {
    const node = `http://${ip}:${port}`;
    const isSyncing = await jsonRpc(node, cmd);
    if (isSyncing) {
      if (isSyncing.isSyncing === true || isSyncing.isSyncing === null || isSyncing.isSyncing === undefined) {
        return false;
      }
    }
    if (providerURL) {
      const blockNum = Number.parseInt(await jsonRpc(node, 'eth_blockNumber'), 16);
      const blockNumB = Number.parseInt(await jsonRpc(providerURL, 'eth_blockNumber'), 16);
      if (blockNumB - blockNum > 1) {
        return false;
      }
    }
    return true;
  } catch (error) {
    return false;
  }
}

async function getBlockchainInfo(host, port, username, password) {
  const time = new Date().getTime();
  const body = {
    jsonrpc: '1.0',
    method: 'getblockchaininfo',
    id: time,
    parameter: [],
  };
  try {
    const response = await httpClients.nodeChecks.post(`http://${host}:${port}`, body, {
      auth: {
        username,
        password,
      },
      timeout,
    });
    // removed due to excessive console logs
    // console.log(response.data);
    return response.data.result;
  } catch (error) {
    console.log(`getBlockchainInfo error: ${error.message}`);
    return false;
  }
}

async function checkBitcoinNode(ip, port, name) {
  const result = await getBlockchainInfo(ip, port, 'user', 'vRqrhHwrtz_zqDe9fCqN-r62wsieb_D7KWpiXIXvynM');
  if (!result) {
    return false;
  }
  if (result.initialblockdownload) {
    return false;
  }
  const currentTime = new Date().getTime();
  const timeDifference = currentTime - (result.time * 1000);
  if (result.blocks > 812722 || name === 'bitcoinnodesignet') {
    if (timeDifference < 1000 * 60 * 60 * 6) { // 6 hours
      return true;
    }
  }
  return false;
}

/**
 * Mirrors FluxOS dockerService.getAppDockerNameIdentifier: the docker name is the
 * bare identifier under the flux namespace, and a name that already starts with
 * `flux` is not prefixed again.
 * FluxOS's underlying getAppIdentifier has two more branches that are deliberately
 * not mirrored here: names already starting with `zel` stay unprefixed, and the
 * hardcoded legacy apps KadenaChainWebNode / FoldingAtHomeB get a `zel` prefix.
 * Neither branch applies to any g: app, and if one ever did, the name produced
 * here would simply never match a running container: the app would fail closed
 * (no master found, dropped from haproxy) rather than route to a standby.
 * @param {string} baseName bare identifier (`{component}_{app}`, or `{app}` for v1-3)
 * @returns {string} docker name as reported in listrunningapps Names[0]
 */
function getDockerNameIdentifier(baseName) {
  return baseName.startsWith('flux') ? `/${baseName}` : `/flux${baseName}`;
}

/**
 * The docker names of the components that only run on a g: app's elected master.
 * Every instance of a compose app runs the components without g: storage, so those
 * say nothing about which node is the master.
 *
 * A named replica's containers carry it as a final `_{replica}` segment. No component,
 * app or replica name may contain `_`, so a replica's names match that replica and none
 * of its co-located siblings.
 * @param {Object} appSpec full application specification
 * @param {string|null} [replica] the named replica, or null for a loose instance
 * @returns {string[]} docker names that identify the master when running
 */
function getGComponentDockerNames(appSpec, replica = null) {
  const suffix = replica ? `_${replica}` : '';
  if (appSpec.version <= 3) {
    return appSpec.containerData.includes('g:')
      ? [getDockerNameIdentifier(`${appSpec.name}${suffix}`)]
      : [];
  }
  return appSpec.compose
    .filter((comp) => comp.containerData.includes('g:'))
    .map((comp) => getDockerNameIdentifier(`${comp.name}_${appSpec.name}${suffix}`));
}

/**
 * What a node was able to tell us about a component.
 *
 * The distinction this carries is the whole point. A node that answers with its
 * container list has settled the question: the component is there or it is not.
 * A node that times out, refuses the connection or returns a body we cannot read
 * has settled nothing. Collapsing those into one `false` is what made
 * checkAppRunningWithRetries back off for six seconds after a node replied in
 * eighty milliseconds that it is not running the app - measured on fdm-eu-1-03 as
 * 390s of a 479s pass - and it is the same collapse that leaves the held check
 * unable to tell "not holding it" from "could not ask".
 *
 * Deliberately the same three names, with the same values, as FluxOS's
 * PeerComponent (appLifecycle/advancedWorkflows.js): both sides are answering the
 * same question about the same component, and a shared vocabulary is what stops
 * the two drifting into disagreeing about what silence means.
 */
const ProbeState = Object.freeze({
  RUNNING: 'running',
  NOT_RUNNING: 'notRunning',
  UNKNOWN: 'unknown',
});

// First contact. Measured on the fleet from fdm-eu-2-02: 306 of 306 selected
// primaries answered, p50 199ms, p95 503ms, slowest 608ms, none over 2s. 12s was
// 20x the slowest real answer, and it was load-bearing only because a failed check
// used to move a primary on its own - which counted confirmations now prevent. The
// headroom that remains is for nodes slower than anything in that sample; it is
// paid in full only by a node that is actually down.
const PROBE_TIMEOUT_MS = 6000;

/**
 * One node's container names, fetched once.
 *
 * Split out from the per-app decision so a pass can ask each node what it runs a
 * single time and answer every app from that. The old shape asked once per
 * (app, candidate) pair, which re-asked the same node the same question for
 * every app it happened to be a candidate for.
 *
 * `answered` is not `ok`. It means "asking again cannot change this", and only a
 * 404/501 qualifies: the route does not exist on that node and will not exist
 * three seconds later. Most of the fleet cannot serve /apps/heldcomponents until
 * flux#1777 ships and answers 404 to every probe - 61 nodes per pass on a dev
 * FDM - and putting those through the full ladder is the same waste as sleeping
 * on a definitive negative.
 *
 * Every other failure is retried, including 5xx: FluxOS answers 503 while a
 * reconciler pass holds an app lock, and a node that is merely busy must not be
 * mistaken for one that has given its final answer.
 *
 * Either way it is `ok: false`: a node that cannot say what it holds has not
 * said it holds nothing.
 *
 * @param {string} url node ip, optionally with api port
 * @param {string} route endpoint path
 * @param {number} [timeoutMs] probe timeout; a node already believed down is
 *   given a shorter one, since that wait is paid on every pass
 * @returns {Promise<{ok: boolean, answered: boolean, names: Set<string>}>}
 */
async function fetchNodeNames(url, route, timeoutMs = PROBE_TIMEOUT_MS) {
  try {
    const ip = url.split(':')[0];
    const port = url.split(':')[1] || 16127;
    const response = await httpClients.nodeChecks.get(`http://${ip}:${port}${route}`, { timeout: timeoutMs });
    const payload = response.data && response.data.data;
    // A 200 carrying an in-band error object: answered, but unreadable.
    if (!Array.isArray(payload)) return { ok: false, answered: true, names: new Set() };
    // listrunningapps yields container objects, heldcomponents bare strings.
    const names = new Set(
      payload
        .map((entry) => (typeof entry === 'string' ? entry : entry?.Names?.[0]))
        .filter((raw) => typeof raw === 'string')
        .map((raw) => raw.replace(/^\//, '')),
    );
    return { ok: true, answered: true, names };
  } catch (error) {
    // A status is only a FINAL answer when it says the node will still be
    // answering that way in three seconds. 404 means the route does not exist
    // here - a node too old for it does not grow one on a retry. 5xx, 429 and
    // 408 are the node saying "not now", which is exactly what the ladder is
    // for: FluxOS returns 503 while a reconciler pass holds the app lock, and
    // the old code gave that node three attempts.
    const status = error.response ? error.response.status : 0;
    const routeWillNeverExist = status === 404 || status === 501;
    return { ok: false, answered: routeWillNeverExist, names: new Set() };
  }
}

/**
 * Everything one node is running, as bare container names.
 * @param {string} url node ip, optionally with api port
 * @param {number} [timeoutMs] probe timeout
 * @returns {Promise<{ok: boolean, names: Set<string>}>}
 */
function fetchRunningNames(url, timeoutMs) {
  return fetchNodeNames(url, '/apps/listrunningapps', timeoutMs);
}

/**
 * Everything one node reports HOLDING, as bare container names.
 * A node too old for the route answers 404, which is `ok: false` - it cannot say.
 * @param {string} url node ip, optionally with api port
 * @param {number} [timeoutMs] probe timeout
 * @returns {Promise<{ok: boolean, names: Set<string>}>}
 */
function fetchHeldNames(url, timeoutMs) {
  return fetchNodeNames(url, '/apps/heldcomponents', timeoutMs);
}

/**
 * Read a fetched name set as a verdict about one instance of an app's g: components.
 * @param {{ok: boolean, names: Set<string>}} fetched
 * @param {Object} appSpec full application specification
 * @param {string|null} [replica] the named replica, or null for a loose instance
 * @returns {string} a ProbeState
 */
function stateFromNames(fetched, appSpec, replica = null) {
  if (!fetched.ok) return ProbeState.UNKNOWN;
  const expectedNames = getGComponentDockerNames(appSpec, replica);
  if (!expectedNames.length) return ProbeState.NOT_RUNNING;
  const hit = expectedNames.some((name) => fetched.names.has(name.replace(/^\//, '')));
  return hit ? ProbeState.RUNNING : ProbeState.NOT_RUNNING;
}

/**
 * Whether a node is the elected master of a g: application.
 * Only the master runs g: components, so any one of them running identifies it.
 * A master whose other components have stopped is still the master, and still
 * serves the ports of the components it does have up, so this deliberately does
 * not require all of them.
 * @param {string} url node ip, optionally with api port
 * @param {Object} appSpec full application specification
 * @returns {Promise<boolean>} true if any g: component is running there
 */
async function checkAppRunningState(url, appSpec) {
  if (!getGComponentDockerNames(appSpec).length) {
    // Only reachable if a non-g: app got routed down the g: path. Passing here
    // would green-light every node, so refuse instead of guessing.
    log.warn(`checkAppRunning: app ${appSpec.name} has no g: component, cannot identify a master`);
    return ProbeState.NOT_RUNNING;
  }
  return stateFromNames(await fetchRunningNames(url), appSpec);
}

async function checkAppRunning(url, appSpec) {
  return (await checkAppRunningState(url, appSpec)) === ProbeState.RUNNING;
}

/**
 * Whether a node is deliberately HOLDING a g: application's components rather
 * than merely not running them.
 *
 * A master whose owner stopped it - to edit world files, swap a save, upload a
 * mod - has no container, so checkAppRunning says no. It is still the master:
 * it owns the writable copy of the syncthing volume, FluxOS is refusing to let
 * any peer elect over it, and it will serve again the moment its owner starts
 * it. Health-checking it away and re-selecting is how a stop/start cycle moves
 * the primary onto another node's copy of the data.
 *
 * This is what `pause` used to give us for free: a paused container still
 * appeared in the running list, so the master was never un-named. `apppause` is
 * retired, and /apps/heldcomponents is the replacement - the node reporting, in
 * its own words, which components it holds.
 *
 * Conservative by construction: a node too old for the endpoint answers 404, an
 * unreachable one throws, and both mean "cannot say", which reads as false and
 * leaves today's behaviour exactly as it was. Only an explicit yes counts.
 *
 * @param {string} url node ip, optionally with api port
 * @param {Object} appSpec full application specification
 * @returns {Promise<boolean>} true only if the node states it holds a g: component
 */
async function checkAppHeldState(url, appSpec) {
  if (!getGComponentDockerNames(appSpec).length) return ProbeState.NOT_RUNNING;
  return stateFromNames(await fetchHeldNames(url), appSpec);
}

async function checkAppHeld(url, appSpec) {
  return (await checkAppHeldState(url, appSpec)) === ProbeState.RUNNING;
}

// The Nth host port this app routes, read off the resolved DeploymentSpec instead of raw
// compose. Every version normalizes onto the same routes, so this replaces the
// version-shaped reads these probes used to do (`app.ports[0]` for v1-3,
// `app.compose[0].ports[N]` for v4+, and nothing at all that worked for v9).
//
// It is also strictly more correct than the expression it replaces. `compose[0].ports[0]`
// is the first COMPONENT's first port, which is `undefined` when that component declares
// no ports — true of explorer and explorerb, whose real port lives on a later component.
// Routes carry only ports that are actually exposed, so index 0 is the app's first
// reachable port. Verified against the live corpus: identical for all 27 probed apps that
// consume it, and it resolves a real port for the two where raw compose gave undefined.
function routedPort(deployment, index = 0) {
  const route = deployment ? deployment.routes()[index] : undefined;
  return route ? route.hostPort : undefined;
}

// Which named apps get a coded health check, and which probe answers for them, is data:
// it changes as apps come and go and says nothing about how a probe works. It lives in
// config/appChecks.json. What stays here is how to call each probe — the argument
// plumbing, which is genuinely code.
//
// One lookup serves both "does this app have a check" and "run it", so the two cannot
// disagree. They used to be separate if/else chains listing the same conditions in the
// same order, kept in step by hand; adding an app to one and not the other either skipped
// its check silently or called a probe that was never meant to run for it.
//
// First rule wins, so order in the file is precedence.
function checkRuleFor(appName) {
  return config.appChecks.checks.find(
    (rule) => (rule.apps && rule.apps.includes(appName))
      || (rule.prefix && appName.startsWith(rule.prefix)),
  ) || null;
}

// Each probe takes what it needs from the rule, the app and its resolved deployment.
// `ip` is the node address as FDM holds it (host:apiPort, IPv6 bracketed); `host` is that
// address with the port stripped.
const PROBES = {
  generalWebsite: (rule, { host, app, deployment }) => generalWebsiteCheck(host, routedPort(deployment), undefined, app.name),
  fluxExplorer: (rule, { host }) => checkFluxExplorer(host, rule.port),
  bitcoinNode: (rule, { host, app, deployment }) => checkBitcoinNode(host, routedPort(deployment), app.name),
  alphExplorer: (rule, { host }) => checkALPHexplorer(host, rule.port),
  ethers: (rule, { host }) => checkEthers(host, rule.port, rule.providerURL, rule.cmd),
  // Blockbook is the one probe addressed by the node's own IPv6 literal when it has one,
  // taking the port from the address rather than the deployment.
  blockBook: (rule, {
    ip, host, app, deployment,
  }) => checkBlockBook(
    ip.includes('[') ? `${ip.split(']')[0]}]` : host,
    ip.includes(']:') ? ip.split(']:')[1] : routedPort(deployment),
    app.name,
    rule.coins,
  ),
};

function applicationWithChecks(app) {
  return checkRuleFor(app.name) !== null;
}

// `probes` is injectable so the dispatch can be tested without standing up
// the network calls it selects. Production always uses PROBES.
async function checkApplication(app, ip, deployment, probes = PROBES) {
  const rule = checkRuleFor(app.name);
  if (!rule) return true;
  const isOK = await probes[rule.probe](rule, {
    ip, host: ip.split(':')[0], app, deployment,
  });
  return isOK;
}

async function refreshFluxBlockheight() {
  try {
    const response = await httpClients.explorer.get('https://explorer.runonflux.io/api/status', { timeout });
    const height = response.data.info.blocks;
    if (height > currentFluxBlockheight) {
      currentFluxBlockheight = height;
    }
  } catch (error) {
    log.error(`Error obtaining flux height: ${error.message}`);
  }
}

let blockheightRefreshTimer = null;

// Begin the periodic flux-height refresh. Importing this module does nothing on
// its own; the boot sequence calls this once. Idempotent, and the timer is
// unref'd so the refresh alone never holds the process open.
function startBlockheightRefresh() {
  if (blockheightRefreshTimer) return;
  blockheightRefreshTimer = setInterval(refreshFluxBlockheight, 120 * 1000);
  blockheightRefreshTimer.unref();
}

module.exports = {
  startBlockheightRefresh,
  // The version-blind probe-port lookup, exported so it can be pinned without standing
  // up the network probes that consume it.
  routedPort,
  checkMainFlux,
  checkFluxExplorer,
  generalWebsiteCheck,
  checkApplication,
  applicationWithChecks,
  checkBlockBook,
  checkEthers,
  checkAppRunning,
  checkAppHeld,
  checkAppRunningState,
  checkAppHeldState,
  fetchRunningNames,
  fetchHeldNames,
  stateFromNames,
  ProbeState,
  PROBE_TIMEOUT_MS,
  getGComponentDockerNames,
  checkALPHexplorer,
  hasManyApps,
  isArcaneOS,
  hasManyApps,
};

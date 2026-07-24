const axios = require('axios');
const config = require('config');
const https = require('https');
const ethers = require('ethers');
const serviceHelper = require('../serviceHelper');
const log = require('../../lib/log');
const { parseSocketAddress } = require('../socketAddress');

const timeout = 5456;
let currentFluxBlockheight = 1968478;
// MAIN
async function checkLoginPhrase(ip, port) {
  try {
    const url = `http://${ip}:${port}/id/loginphrase`;
    const response = await serviceHelper.httpGetRequest(url, timeout);
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
    const responseA = await serviceHelper.httpGetRequest(urlA, timeout);
    if (responseA.data.data.length > 8) {
      const responseB = await serviceHelper.httpGetRequest(urlB, timeout);
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
    const response = await serviceHelper.httpGetRequest(url, timeout);
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
    const response = await serviceHelper.httpGetRequest(url, timeout);
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
    const response = await serviceHelper.httpGetRequest(url, timeout);
    const { version } = response.data.data.flux;
    if (minVersionSatisfy(version, '8.2.0')) {
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
    const response = await serviceHelper.httpGetRequest(url, timeout);
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
    const response = await serviceHelper.httpGetRequest(url, timeout);
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
    const response = await serviceHelper.httpGetRequest(url, timeout);
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

// Whether this node's view of the app population looks complete enough to serve the main
// domain. A node that knows about only a handful of apps is out of sync with the network
// and must not be balanced onto, however healthy it otherwise looks.
//
// Both conditions reject: too few apps at all, and a known app missing from a list that is
// otherwise large. The count is a floor rather than a target — a node in step reports the
// whole population (761 when this was written, uniform across every node sampled), so
// anything near the floor is already badly behind.
async function hasManyApps(ip, port) {
  try {
    const url = `http://${ip}:${port}/apps/globalappsspecifications`;
    const response = await serviceHelper.httpGetRequest(url, timeout);
    const apps = response.data.data;
    if (apps.length < config.appChecks.mainNode.minKnownApps) {
      log.info(`Function hasManyApps false for ip ${ip}: knows of ${apps.length} apps`);
      return false;
    }
    // eslint-disable-next-line no-restricted-syntax
    for (const app of config.mandatoryApps) {
      const appExists = apps.find((a) => a.name === app);
      if (!appExists) {
        log.info(`Function hasManyApps false for ip ${ip}: missing ${app}`);
        return false;
      }
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
    const response = await serviceHelper.httpGetRequest(url, timeout);
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
    const websiteResponse = await serviceHelper.httpGetRequest(`http://${ip}:${port}/blocks`, 14888);
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
  const response = await serviceHelper.httpGetRequest(url, 8888);
  const blockUrlAdjusted = blockUlr + response.data.blocks[0].hash;
  const responseB = await serviceHelper.httpGetRequest(blockUrlAdjusted, 8888);
  const { txid } = responseB.data.txs[0];
  const adjustedUrlTx = txUrl + txid;
  const responseC = await serviceHelper.httpGetRequest(adjustedUrlTx, 8888);
  if (responseC.data.confirmations < -2) {
    return false;
  }
  return true;
}

async function checkFluxExplorer(ip, port) {
  try {
    const response = await serviceHelper.httpGetRequest(`http://${ip}:${port}/api/addr/t3c51GjrkUg7pUiS8bzNdTnW2hD25egWUih`, 8888);
    const responseB = await serviceHelper.httpGetRequest(`http://${ip}:${port}/api/sync`, 8888);
    const responseC = await serviceHelper.httpGetRequest(`http://${ip}:${port}/api/circulation`, 8888);
    const responseD = await serviceHelper.httpGetRequest(`http://${ip}:${port}/api/status`, 8888);
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
    const websiteResponse = await serviceHelper.httpGetRequest(`http://${ip}:${port}`, timeOut);
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
    const agent = new https.Agent({
      rejectUnauthorized: false,
    });
    const { CancelToken } = axios;
    const source = CancelToken.source();
    let isResolved = false;
    setTimeout(() => {
      if (!isResolved) {
        source.cancel('Operation canceled by the user.');
      }
    }, timeout * 2);
    // Blockbook is addressed over https when the node gave us an IPv6 literal.
    const overIPv6 = ip.includes(':');
    const get = async (path) => {
      const response = overIPv6
        ? await axios.get(`https://${ip}:${port}${path}`, { httpsAgent: agent, timeout, cancelToken: source.token })
        : await serviceHelper.httpGetRequest(`http://${ip}:${port}${path}`, 5000);
      return response.data;
    };

    const info = await get('/api');
    isResolved = true;

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

async function checkEthers(ip, port, providerURL, cmd) {
  try {
    const timeoutPromise = new Promise((resolve) => {
      setTimeout(resolve, 10000, true);
    });
    const node = `http://${ip}:${port}`;
    const provider = new ethers.providers.JsonRpcProvider(node);
    const syncingPromise = provider.send(cmd);
    const isSyncing = await Promise.race([syncingPromise, timeoutPromise]);
    if (isSyncing) {
      if (isSyncing.isSyncing === true || isSyncing.isSyncing === null || isSyncing.isSyncing === undefined) {
        return false;
      }
    }
    if (providerURL) {
      const blockNum = await provider.getBlockNumber();
      const providerB = new ethers.providers.JsonRpcProvider(providerURL);
      const blockNumB = await providerB.getBlockNumber();
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
    const { CancelToken } = axios;
    const source = CancelToken.source();
    let isResolved = false;
    setTimeout(() => {
      if (!isResolved) {
        source.cancel('Operation canceled by the user.');
      }
    }, timeout * 2);
    const response = await axios.post(`http://${host}:${port}`, body, {
      auth: {
        username,
        password,
      },
      timeout,
      cancelToken: source.token,
    });
    isResolved = true;
    // removed due to excessive console logs
    // console.log(response.data);
    return response.data.result;
  } catch (error) {
    console.log(`getBlockchainInfo error: ${error.message}`);
    return false;
  }
}

const BITCOIN_MAX_TIP_AGE_MS = 6 * 60 * 60 * 1000;

// Is this node serving the chain the app is for, and is it current?
//
// `chain` is what getblockchaininfo reports the node is actually on — "main", "test",
// "signet", "regtest" — so the question is asked directly. It used to be asked as
// `blocks > 812722`, a bitcoin mainnet height applied to all three apps, with signet
// exempted by name because it could never satisfy it: signet is at 314533, less than half
// the floor, so every signet node passed only because of that exemption. A height standing
// in for an identity needs an exemption per chain that happens to be shorter than bitcoin,
// and grants one to any chain that happens to be longer.
async function checkBitcoinNode(ip, port, expectedChain) {
  const result = await getBlockchainInfo(ip, port, 'user', 'vRqrhHwrtz_zqDe9fCqN-r62wsieb_D7KWpiXIXvynM');
  if (!result) {
    return false;
  }
  if (result.initialblockdownload) {
    return false;
  }
  if (expectedChain && result.chain !== expectedChain) {
    log.info(`Bitcoin node ${ip}:${port} is on chain ${result.chain}, expected ${expectedChain}`);
    return false;
  }
  const tipAge = Date.now() - (result.time * 1000);
  return tipAge < BITCOIN_MAX_TIP_AGE_MS;
}

// Is this app's instance running on that node? `replica` narrows the question to one
// named replica: a node can host several co-located replicas of the same app, and for an
// active-standby app the answer for one of them is not the answer for its siblings.
// Container names carry the identifier `{component}_{app}` — `{component}_{app}_{replica}`
// when the replica is named — and none of those three segments may contain `_`, so
// `{app}_{replica}` matches that replica and nothing else.
async function checkAppRunning(socketAddress, appName, replica = null) {
  try {
    const { CancelToken } = axios;
    const source = CancelToken.source();
    let isResolved = false;
    const checkAppRunningTimeout = 12000;
    setTimeout(() => {
      if (!isResolved) {
        source.cancel('Operation canceled by the user.');
      }
    }, checkAppRunningTimeout * 2);

    const { host, port } = parseSocketAddress(socketAddress);
    const response = await axios.get(`http://${host}:${port || 16127}/apps/listrunningapps`, { timeout: checkAppRunningTimeout, cancelToken: source.token });
    isResolved = true;
    const appsRunning = response.data.data;
    const marker = replica ? `${appName}_${replica}` : appName;
    if (appsRunning.find((app) => app.Names[0].includes(marker))) {
      return true;
    }
    return false;
  } catch (error) {
    return false;
  }
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
// `host` is the node's address without a port; `servicePort` is the port the app answers
// on when the location itself declared one, which only the configured fixed addresses do.
// Everything else takes the port from the deployment.
const PROBES = {
  generalWebsite: (rule, { host, app, deployment }) => generalWebsiteCheck(host, routedPort(deployment), undefined, app.name),
  // `rule.port` overrides the spec for the probes that target a component other than the
  // first routed one — alphexplorer's backend, not its daemon. Everything else takes the
  // port the owner declared, so a redeploy on a different port does not silently stop the
  // check applying. explorer and explorerb differ here: 39185 and 38200.
  fluxExplorer: (rule, { host, deployment }) => checkFluxExplorer(host, rule.port || routedPort(deployment)),
  bitcoinNode: (rule, { host, deployment }) => checkBitcoinNode(host, routedPort(deployment), rule.chain),
  alphExplorer: (rule, { host }) => checkALPHexplorer(host, rule.port),
  ethers: (rule, { host }) => checkEthers(host, rule.port, rule.providerURL, rule.cmd),
  blockBook: (rule, {
    host, servicePort, app, deployment,
  }) => checkBlockBook(host, servicePort || routedPort(deployment), app.name, rule.coins),
};

function applicationWithChecks(app) {
  return checkRuleFor(app.name) !== null;
}

// `location` is where the app is running, as resolveAppLocations produced it: `ip` is the
// address FDM routes to, and `servicePort` is set only when the location declared the
// app's own port. `probes` is injectable so the dispatch can be tested without standing up
// the network calls it selects. Production always uses PROBES.
async function checkApplication(app, location, deployment, probes = PROBES) {
  const rule = checkRuleFor(app.name);
  if (!rule) return true;
  const { host } = parseSocketAddress(location.ip);
  const isOK = await probes[rule.probe](rule, {
    ip: location.ip, host, servicePort: location.servicePort || null, app, deployment,
  });
  return isOK;
}

async function refreshFluxBlockheight() {
  try {
    const { CancelToken } = axios;
    const source = CancelToken.source();
    let isResolved = false;
    setTimeout(() => {
      if (!isResolved) {
        source.cancel('Operation canceled by the user.');
      }
    }, timeout * 2);
    const response = await axios.get('https://explorer.runonflux.io/api/status', { timeout, cancelToken: source.token });
    isResolved = true;
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
  checkBitcoinNode,
  checkEthers,
  checkAppRunning,
  checkALPHexplorer,
  hasManyApps,
  isArcaneOS,
};

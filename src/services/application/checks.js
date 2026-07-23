const axios = require('axios');
const config = require('config');
const https = require('https');
const ethers = require('ethers');
const serviceHelper = require('../serviceHelper');
const log = require('../../lib/log');

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

async function checkBlockBook(ip, port, appsname) {
  try {
    const coinList = ['litecoin', 'flux', 'ethereumclassic', 'vertcoin', 'zcash', 'dogecoin', 'digibyte', 'groestlcoin', 'dash', 'firo', 'sin', 'ravencoin', 'pivx', 'decred', 'neurai', 'bitcoin', 'bitcointestnet', 'bitcoinsignet', 'clore', 'bitcoincash', 'bitcoingold'];
    const addressList = ['LVjoCYFESyTbKAEU5VbFYtb9EYyBXx55V5', 't3fK9bY31MGCqhKw34cg9gg168SHCfcMGHe', '0x0e009d19cb4693fcf2d15aaf4a5ee1c8a0bb5ecf', 'VbFrQgNEiR8ZxMh9WmkjJu9kkqjJA6imdD',
      't1UPSwfMYLe18ezbCqnR5QgdJGznzCUYHkj', 'DFewUat3fj7pbMiudwbWpdgyuULCiVf6q8', 'DFewUat3fj7pbMiudwbWpdgyuULCiVf6q8', 'FfgZPEfmvou5VxZRnTbRjPKhgVsrx7Qjq9',
      'XmCgmabJL2S8DJ8tmEvB8QDArgBbSSMJea', 'aBEJgEP2b7DP7tyQukv639qtdhjFhWp2QE', 'SXoqyAiZ6gQjafKmSnb2pmfwg7qLC8r4Sf', 'RKo31qpgy9278MuWNXb5NPranc4W6oaUFf',
      'DTVg3KVrPiv9QLPT1cYQ8XYV6SUugMYkZV', 'DsUbTWsJWNzNdfUigTrUqbxmnwntDBJXasi', 'NfXjy71SH9CdC8tNzQjkYGKUCYfMsTPaKS', '12ib7dApVFvg82TXKycWBNpN8kFyiAN1dr', 'tb1qzzlexm9xz8zthacl5tl0ewp2yu9tq0jp2tt6e0', 'tb1pwzv7fv35yl7ypwj8w7al2t8apd6yf4568cs772qjwper74xqc99sk8x7tk',
      'AMq8KfE2iJtMbKNMtHp3VmJFFKmyLoMwuG', 'bitcoincash:qr8ger8kn2fz5cr73cp7ylkqznauyjyzuqwwh4uqht', 'GLTodZWWjuMWmXhu2fAtPM4e4Sv6Z2oZYP'];
    const heightList = [2561528, 1969000, 18510512, 2067081, 2260134, 4922428, 18038850, 4796068, 1953740, 764150, 1690368, 3015843, 4085836, 807730, 255116, 812896, 68910, 165752, 516509, 845000, 850000];
    let coin = appsname.replace('blockbook', '');
    coin = coin.replace(/\d+/g, '');
    const index = coinList.indexOf(coin);
    let response1;
    let response2;
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
    if (ip.includes(':')) {
      response1 = await axios.get(`https://${ip}:${port}/api`, { httpsAgent: agent, timeout, cancelToken: source.token });
      response2 = await axios.get(`https://${ip}:${port}/api/v2/address/${addressList[index]}?pageSize=50`, { httpsAgent: agent, timeout, cancelToken: source.token });
      isResolved = true;
    } else {
      response1 = await serviceHelper.httpGetRequest(`http://${ip}:${port}/api`, 5000);
      response2 = await serviceHelper.httpGetRequest(`http://${ip}:${port}/api/v2/address/${addressList[index]}?pageSize=50`, 5000);
      isResolved = true;
    }
    if (coin === 'flux') {
      if (response1.data.backend.version !== 'zebra' && +response1.data.backend.version < 8000050) { // consider zebra always valid
        return false;
      }
    }
    const currentTime = new Date().getTime();
    if (response2.data.txids.length > 0 && response1.data.blockbook.bestHeight > (response1.data.backend.blocks - 100) && response1.data.blockbook.bestHeight > heightList[index] && response1.data.backend.blocks > heightList[index]) {
      const lastBlockTmstp = new Date(response1.data.blockbook.lastBlockTime).getTime();
      const timeDifference = currentTime - lastBlockTmstp;
      if (response2.data.txs <= 50 && response2.data.txids.length === response2.data.txs) {
        if (response2.data.txids.length === response2.data.txs) {
          if (timeDifference < 1000 * 60 * 60 * 3) { // 3 hours
            return true;
          }
        }
      } else if (response2.data.txs > 50 && response2.data.totalPages > response2.data.page) {
        if (response2.data.txids.length >= 50) {
          if (timeDifference < 1000 * 60 * 60 * 3) { // 3 hours
            return true;
          }
        }
      } else if (response2.data.txs > 50 && response2.data.totalPages === response2.data.page) {
        if (response2.data.txids.length === response2.data.txs % 50) {
          if (timeDifference < 1000 * 60 * 60 * 3) { // 3 hours
            return true;
          }
        }
      }
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

// Is this app's instance running on that node? `replica` narrows the question to one
// named replica: a node can host several co-located replicas of the same app, and for an
// active-standby app the answer for one of them is not the answer for its siblings.
// Container names carry the identifier `{component}_{app}` — `{component}_{app}_{replica}`
// when the replica is named — and none of those three segments may contain `_`, so
// `{app}_{replica}` matches that replica and nothing else.
async function checkAppRunning(url, appName, replica = null) {
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

    const ip = url.split(':')[0];
    const port = url.split(':')[1] || 16127;
    const response = await axios.get(`http://${ip}:${port}/apps/listrunningapps`, { timeout: checkAppRunningTimeout, cancelToken: source.token });
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
  ),
};

function applicationWithChecks(app) {
  return checkRuleFor(app.name) !== null;
}

// `probes` is injectable so the dispatch can be tested without standing up the network
// calls it selects. Production always uses PROBES.
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
  checkEthers,
  checkAppRunning,
  checkALPHexplorer,
  hasManyApps,
  isArcaneOS,
};

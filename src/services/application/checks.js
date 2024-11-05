/* eslint-disable no-unused-vars */
const gamedig = import('gamedig');

const axios = require('axios');
const config = require('config');
const https = require('https');
const ethers = require('ethers');
const serviceHelper = require('../serviceHelper');
const domainService = require('../domainService');
const log = require('../../lib/log');

const timeout = 5456;
const generalWebsiteApps = ['website', 'AtlasCloudMainnet', 'HavenVaultMainnet', 'KDLaunch', 'paoverview', 'FluxInfo', 'Jetpack2', 'jetpack', 'web', 'eckodexswap', 'eckodexvault'];
const ethersList = [
  {
    name: 'BitgertRPC', providerURL: null, cmd: 'eth_syncing', port: '32300',
  },
  {
    name: 'CeloRPC', providerURL: 'https://forno.celo.org', cmd: 'eth_syncing', port: '35000',
  },
  {
    name: 'WanchainRpc', providerURL: null, cmd: 'eth_syncing', port: '31000',
  },
  {
    name: 'FuseRPC', providerURL: 'https://fuse-mainnet.chainstacklabs.com', cmd: 'eth_syncing', port: '38545',
  },
  {
    name: 'AstarRPC', providerURL: null, cmd: 'system_health', port: '36011',
  },
];
let currentFluxBlockheight = 1753857;
// MAIN
async function checkLoginPhrase(ip, port) {
  try {
    const url = `http://${ip}:${port}/id/loginphrase`;
    const response = await serviceHelper.httpGetRequest(url, timeout);
    if (response.data.status === 'success') {
      return true;
    }
    return false;
  } catch (error) {
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
    return false;
  } catch (error) {
    return false;
  }
}

async function isHomeOK(ip, port) {
  try {
    const url = `http://${ip}:${port}`;
    const response = await serviceHelper.httpGetRequest(url, timeout);
    if (response.data.toLowerCase().startsWith('<!doctype html><html')) {
      return true;
    }
    return false;
  } catch (error) {
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

async function isVersionOK(ip, port) {
  try {
    const url = `http://${ip}:${port}/flux/info`;
    const response = await serviceHelper.httpGetRequest(url, timeout);
    const version = response.data.data.flux.version;
    if (minVersionSatisfy(version, '5.33.0')) {
      if (response.data.data.flux.development === 'false' || !response.data.data.flux.development) {
        return true;
      }
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
    if (height >= currentFluxBlockheight) {
      return true;
    }
    return false;
  } catch (error) {
    return false;
  }
}

async function isDaemonSyncedOK(ip, port) {
  try {
    const url = `http://${ip}:${port}/daemon/getblockchaininfo`;
    const response = await serviceHelper.httpGetRequest(url, timeout);
    if (response.data.data.blocks + 3 >= response.data.data.headers) {
      return true;
    }
    return false;
  } catch (error) {
    return false;
  }
}

async function hasManyApps(ip, port) {
  try {
    const url = `http://${ip}:${port}/apps/globalappsspecifications`;
    const response = await serviceHelper.httpGetRequest(url, timeout);
    const appsAmount = response.data.data.length;
    if (appsAmount > 1000) { // we surely have at least 1000 apps on network
      // eslint-disable-next-line no-restricted-syntax
      for (const app of config.mandatoryApps) {
        const appExists = response.data.data.find((a) => a.name === app);
        if (!appExists) {
          return false;
        }
      }
    }
    return true;
  } catch (error) {
    return false;
  }
}

async function hasManyMessages(ip, port) {
  try {
    const url = `http://${ip}:${port}/apps/hashes`;
    const response = await serviceHelper.httpGetRequest(url, timeout);
    const appsAmount = response.data.data.length;
    if (appsAmount > 29000) {
      const messageFalse = response.data.data.filter((a) => a.message === false);
      if (messageFalse.length < 80) {
        return true;
      }
    }
    return false;
  } catch (error) {
    return false;
  }
}

async function checkMainFlux(ip, port = 16127) {
  try {
    const versionOK = await isVersionOK(ip, port);
    if (versionOK) {
      // eslint-disable-next-line no-await-in-loop
      const loginPhraseOK = await checkLoginPhrase(ip, port);
      if (loginPhraseOK) {
        // eslint-disable-next-line no-await-in-loop
        const communicationOK = await isCommunicationOK(ip, port);
        if (communicationOK) {
          const isSynced = await isSyncedOK(ip, port);
          if (isSynced) {
            const isDaemonSynced = isDaemonSyncedOK(ip, port);
            if (isDaemonSynced) {
              const hasApps = await hasManyApps(ip, port);
              if (hasApps) {
                const hasMessages = await hasManyMessages(ip, port);
                if (hasMessages) {
                  // eslint-disable-next-line no-await-in-loop
                  const uiOK = await isHomeOK(ip, +port - 1);
                  if (uiOK) {
                    return true;
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

// KUSAMA
function checkheightOKksm(height) {
  const currentTime = new Date().getTime();
  const baseTime = 1622640282000;
  const baseHeight = 7739485;
  const timeDifference = currentTime - baseTime;
  const blocksPassedInDifference = (timeDifference / 6000); // 6 secs
  const currentBlockEstimation = baseHeight + blocksPassedInDifference;
  const minimumAcceptedBlockHeight = currentBlockEstimation - 600; // allow being off sync for 600 blocks; 1 hour
  console.log(minimumAcceptedBlockHeight);
  if (height > minimumAcceptedBlockHeight) {
    return true;
  }
  return false;
}

function checkheightOKdot(height) {
  const currentTime = new Date().getTime();
  const baseTime = 1622640408000;
  const baseHeight = 5331005;
  const timeDifference = currentTime - baseTime;
  const blocksPassedInDifference = (timeDifference / 6000); // 6 secs
  const currentBlockEstimation = baseHeight + blocksPassedInDifference;
  const minimumAcceptedBlockHeight = currentBlockEstimation - 600; // allow being off sync for 600 blocks; 1 hour
  console.log(minimumAcceptedBlockHeight);
  if (height > minimumAcceptedBlockHeight) {
    return true;
  }
  return false;
}

// POLKADOT

async function getPolkaNetworkHeight(ip, port) {
  try {
    const max = 1000000;
    const min = 1;

    const data = {
      jsonrpc: '2.0',
      method: 'system_syncState',
      params: [],
      id: Math.floor(Math.random() * (max - min + 1)) + min,
    };
    const headers = {
      'Content-Type': 'application/json',
    };
    const rosettaData = await serviceHelper.httpPostRequest(`http://${ip}:${port}/network/status`, data, 3456, headers);
    console.log(rosettaData.data.result);
    return rosettaData.data.result.currentBlock;
  } catch (e) {
    // log.error(e);
    return -1;
  }
}

// ROSETTA
async function checkRosettaSynced(ip, height) {
  try {
    const agent = new https.Agent({
      rejectUnauthorized: false,
    });
    const data = {
      network_identifier: {
        blockchain: 'flux',
        network: 'mainnet',
      },
      block_identifier: {
        index: height - 30,
      },
    };
    const rosettaData = await serviceHelper.httpPostRequest(`http://${ip}:38080/network/status`, data, 3456, undefined, agent);
    return rosettaData.data.block.block_identifier.index;
  } catch (e) {
    // log.error(e);
    return false;
  }
}

async function getRosettaHeight(ip) {
  try {
    const agent = new https.Agent({
      rejectUnauthorized: false,
    });
    const data = {
      network_identifier: {
        blockchain: 'flux',
        network: 'mainnet',
      },
    };
    const rosettaData = await serviceHelper.httpPostRequest(`http://${ip}:38080/network/status`, data, 3456, undefined, agent);
    return rosettaData.data.current_block_identifier.index;
  } catch (e) {
    // log.error(e);
    return -1;
  }
}

function checkRosettaheightOK(height) {
  const currentTime = new Date().getTime();
  const baseTime = 1623245290000;
  const baseHeight = 878090;
  const timeDifference = currentTime - baseTime;
  const blocksPassedInDifference = (timeDifference / 120000); // 120 secs
  const currentBlockEstimation = baseHeight + blocksPassedInDifference;
  const minimumAcceptedBlockHeight = currentBlockEstimation - 720; // allow being off sync for 720 blocks; 1 day
  if (height > minimumAcceptedBlockHeight) {
    return true;
  }
  return false;
}

// KADENA
function kadenaCheckHeight(height) {
  const currentTime = new Date().getTime();
  const baseTime = 1625422726000;
  const baseHeight = 35347955;
  const timeDifference = currentTime - baseTime;
  const blocksPassedInDifference = (timeDifference / 30000) * 20; // 20 chains with blocktime 30 seconds
  const currentBlockEstimation = baseHeight + blocksPassedInDifference;
  const minimumAcceptedBlockHeight = currentBlockEstimation - (60 * 310); // allow being off sync for 1200 blocks; 30 mins
  if (height > minimumAcceptedBlockHeight) {
    return true;
  }
  return false;
}

function kadenaCheckPeers(peers) {
  try {
    const goodPeers = peers.filter((peer) => peer.address.hostname.includes('chainweb')); // has outside of flux too
    if (goodPeers.length > 1) { // at least 2 chainweb peers
      return true;
    }
    const goodPeersPort = peers.filter((peer) => peer.address.port !== 31350); // has outside of flux too
    if (goodPeersPort.length > 4) { // at least 5 different than flux peers
      return true;
    }
    return false;
  } catch (error) {
    log.error(error);
    return true;
  }
}

async function kadenaGetHeight(ip) {
  try {
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
    const kadenaData = await axios.get(`https://${ip}:31350/chainweb/0.0/mainnet01/cut`, { httpsAgent: agent, timeout, cancelToken: source.token });
    isResolved = true;
    return kadenaData.data.height;
  } catch (e) {
    // log.error(e);
    return -1;
  }
}

async function kadenaGetConenctions(ip) {
  try {
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
    const kadenaData = await axios.get(`https://${ip}:31350/chainweb/0.0/mainnet01/cut/peer`, { httpsAgent: agent, timeout, cancelToken: source.token });
    isResolved = true;
    return kadenaData.data.items;
  } catch (e) {
    // log.error(e);
    return [];
  }
}

async function checkKadenaApplication(ip) {
  try {
    const height = await kadenaGetHeight(ip);
    if (kadenaCheckHeight(height)) {
      // eslint-disable-next-line no-await-in-loop
      const peers = await kadenaGetConenctions(ip);
      if (kadenaCheckPeers(peers)) {
        return true;
      }
    }
    return false;
  } catch (error) {
    return false;
  }
}

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
    log.info('e');
    log.info(error);
    return false;
  }
}

async function checkErgoHeight(ip, port) {
  try {
    const response = await serviceHelper.httpGetRequest(`http://${ip}:${port}/info`, 5000);
    const { fullHeight, maxPeerHeight, headersHeight } = response.data;

    // Check if fullHeight matches maxPeerHeight and headersHeight
    if (fullHeight === maxPeerHeight && headersHeight === maxPeerHeight) {
      return true;
    }
    return false;
  } catch (error) {
    return false;
  }
}

async function checkRunOnFluxWebsite(ip, port) {
  try {
    const websiteResponse = await serviceHelper.httpGetRequest(`http://${ip}:${port}`, 8888);
    if (websiteResponse.data.includes('<title>Flux')) {
      return true;
    }
    return false;
  } catch (error) {
    return false;
  }
}

async function checkMOKWebsite(ip, port) {
  try {
    const websiteResponse = await serviceHelper.httpGetRequest(`http://${ip}:${port}`, 5000);
    if (websiteResponse.data.includes('<title>The Miners')) {
      return true;
    }
    return false;
  } catch (error) {
    return false;
  }
}

async function checkCloudAtlasWebsite(ip, port) {
  try {
    const websiteResponse = await serviceHelper.httpGetRequest(`http://${ip}:${port}`, 8888);
    if (websiteResponse.data.includes('<title>Atlas')) {
      return true;
    }
    return false;
  } catch (error) {
    return false;
  }
}

async function checkFluxExplorer(ip, port) {
  try {
    const response = await serviceHelper.httpGetRequest(`http://${ip}:${port}/api/addr/t3c51GjrkUg7pUiS8bzNdTnW2hD25egWUih`, 8888);
    const responseB = await serviceHelper.httpGetRequest(`http://${ip}:${port}/api/sync`, 8888);
    const responseC = await serviceHelper.httpGetRequest(`http://${ip}:${port}/api/circulation`, 8888);
    // eslint-disable-next-line no-use-before-define
    if (response.data.transactions.length > 0 && responseB.data.blockChainHeight >= currentFluxBlockheight && responseC.data.circulationsupply > 372000000) {
      return true;
    }
    return false;
  } catch (error) {
    return false;
  }
}

async function checkHavenHeight(ip, port) {
  try {
    const response = await serviceHelper.httpGetRequest(`http://${ip}:${port}/get_info`, 1500);
    if (response.data.height > response.data.target_height && response.data.height > 1) {
      return true;
    }
    return false;
  } catch (error) {
    return false;
  }
}

async function checkHavenRPC(ip, port) {
  try {
    const data = {
      "jsonrpc": "2.0",
      "id": "0",
      "method": "get_last_block_header"
    }
    await serviceHelper.httpPostRequest(`http://${ip}:${port}/json_rpc`, data, 1500);
    // if code 200 all ok
    return true;
  } catch (error) {
    return false;
  }
}

async function checkKDLaunch(ip, port) {
  try {
    const websiteResponse = await serviceHelper.httpGetRequest(`http://${ip}:${port}`, 2000);
    if (websiteResponse.data.includes('<title>KDLaunch')) {
      return true;
    }
    return false;
  } catch (error) {
    return false;
  }
}

async function checkHavenValut(ip, port) {
  try {
    const websiteResponse = await serviceHelper.httpGetRequest(`http://${ip}:${port}`, 2000);
    if (websiteResponse.data.includes('<title>Haven')) {
      return true;
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
      'DTVg3KVrPiv9QLPT1cYQ8XYV6SUugMYkZV', 'DsUbTWsJWNzNdfUigTrUqbxmnwntDBJXasi', 'NfXjy71SH9CdC8tNzQjkYGKUCYfMsTPaKS', '12ib7dApVFvg82TXKycWBNpN8kFyiAN1dr', 'tb1qcq670zweall6zz4f96flfrefhr8myfxz9ll9l2', 'tb1pwzv7fv35yl7ypwj8w7al2t8apd6yf4568cs772qjwper74xqc99sk8x7tk',
      'AMq8KfE2iJtMbKNMtHp3VmJFFKmyLoMwuG', 'bitcoincash:qr8ger8kn2fz5cr73cp7ylkqznauyjyzuqwwh4uqht', 'GLTodZWWjuMWmXhu2fAtPM4e4Sv6Z2oZYP'];
    const heightList = [2561528, 1489960, 18510512, 2067081, 2260134, 4922428, 18038850, 4796068, 1953740, 764150, 1690368, 3015843, 4085836, 807730, 255116, 812896, 2534408, 165752, 516509, 845000, 850000];
    let coin = appsname.replace('blockbook', '');
    coin = coin.replace(/\d+/g, '');
    const index = coinList.indexOf(coin);
    const response1 = await serviceHelper.httpGetRequest(`http://${ip}:${port}/api`, 5000);
    const response2 = await serviceHelper.httpGetRequest(`http://${ip}:${port}/api/v2/address/${addressList[index]}?pageSize=50`, 5000);
    const currentTime = new Date().getTime();
    if (response2.data.txids.length > 0 && response1.data.blockbook.bestHeight > (response1.data.backend.blocks - 100) && response1.data.blockbook.bestHeight > heightList[index] && response1.data.backend.blocks > heightList[index] && !response1.data.inSync) {
      const lastBlockTmstp = new Date(response1.data.blockbook.lastBlockTime).getTime();
      const timeDifference = currentTime - lastBlockTmstp;
      if (response2.data.txs <= 50 && response2.data.txids.length === response2.data.txs) {
        if (response2.data.txids.length === response2.data.txs) {
          if (timeDifference < 1000 * 60 * 60 * 6) { // 6 hours
            return true;
          }
        }
      } else if (response2.data.txs > 50 && response2.data.totalPages > response2.data.page) {
        if (response2.data.txids.length >= 50) {
          if (timeDifference < 1000 * 60 * 60 * 6) { // 6 hours
            return true;
          }
        }
      } else if (response2.data.txs > 50 && response2.data.totalPages === response2.data.page) {
        if (response2.data.txids.length === response2.data.txs % 50) {
          if (timeDifference < 1000 * 60 * 60 * 6) { // 6 hours
            return true;
          }
        }
      }
    }
    return false;
  } catch (error) {
    return false;
  }
}

async function checkAlgorand(ip, port) {
  const axiosConfig = {
    timeout: 13456,
  };
  try {
    const status = await axios.get(`http://${ip}:${port}/health`, axiosConfig);
    // eslint-disable-next-line no-restricted-syntax
    if (status.data.isSynced === true) {
      return true;
    }
    return false;
  } catch (e) {
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
    const response = await axios.post(`http://${host}:${port}`, body, {
      auth: {
        username,
        password,
      },
    });
    console.log(response.data);
    return response.data.result;
  } catch (error) {
    console.log(error);
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

async function checkMinecraft(ip, port) {
  try {
    const gg = await gamedig;
    const state = await gg.GameDig.query({
      type: 'minecraft',
      host: ip,
      port,
      attemptTimeout: 5000,
      maxRetries: 3
    });
    return true;
  } catch (error) {
    return false;
  }
}

async function checkPalworld(ip, port) {
  try {
    const gg = await gamedig;
    const state = await gg.GameDig.query({
      type: 'palworld',
      host: ip,
      port,
      attemptTimeout: 5000,
      maxRetries: 3
    });
    return true;
  } catch (error) {
    return false;
  }
}

async function checkEnshrouded(ip, port) {
  try {
    const gg = await gamedig;
    const state = await gg.GameDig.query({
      type: 'enshrouded',
      host: ip,
      port,
      attemptTimeout: 5000,
      maxRetries: 3,
    });
    return true;
  } catch (error) {
    return false;
  }
}

async function checkBittensor(ip, port) {
  const url = `http://${ip}:${port}/`;
  const data = {
    id: 1,
    jsonrpc: '2.0',
    method: 'getinfo',
    params: [],
  };
  try {
    await axios.post(url, data, { timeout: 5000 });
    return true;
  } catch (error) {
    return false;
  }
}

async function checkAppRunning(url, appName) {
  try {
    const { CancelToken } = axios;
    const source = CancelToken.source();
    let isResolved = false;
    setTimeout(() => {
      if (!isResolved) {
        source.cancel('Operation canceled by the user.');
      }
    }, timeout * 2);

    const ip = url.split(':')[0];
    const port = url.split(':')[1] || 16127;
    const response = await axios.get(`http://${ip}:${port}/apps/listrunningapps`, { timeout, cancelToken: source.token });
    isResolved = true;
    const appsRunning = response.data.data;
    if (appsRunning.find((app) => app.Names[0].includes(appName) && app.State === 'running')) {
      return true;
    }
    return false;
  } catch (error) {
    return false;
  }
}

function applicationWithChecks(app) {
  if (generalWebsiteApps.includes(app.name)) {
    return true;
  } else if (app.name === 'explorer') {
    return true;
  } else if (app.name === 'bitcoinnode' || app.name === 'bitcoinnodetestnet' || app.name === 'bitcoinnodesignet') {
    return true;
  } else if (app.name === 'HavenNodeMainnet') {
    return true;
  } else if (app.name === 'HavenNodeTestnet') {
    return true;
  } else if (app.name === 'HavenNodeStagenet') {
    return true;
  } else if (app.name.startsWith('blockbook')) {
    return true;
  } else if (app.name.startsWith('AlgorandRPC')) {
    return true;
  } else if (app.name.toLowerCase().includes('bittensor')) {
    return true;
  } else if (app.name === 'alphexplorer') {
    return true;
  } else if (app.name === 'ergo') {
    return true;
  } else {
    const matchIndex = ethersList.findIndex((eApp) => app.name.startsWith(eApp.name));
    if (matchIndex > -1) {
      return true;
    }
  }
  return false;
}

async function checkApplication(app, ip) {
  let isOK = true;
  if (generalWebsiteApps.includes(app.name)) {
    isOK = await generalWebsiteCheck(ip.split(':')[0], app.port || app.ports ? app.ports[0] : app.compose[0].ports[0], undefined, app.name);
  } else if (app.name === 'explorer') {
    isOK = await checkFluxExplorer(ip.split(':')[0], 39185);
  } else if (app.name === 'bitcoinnode' || app.name === 'bitcoinnodetestnet' || app.name === 'bitcoinnodesignet') {
    isOK = await checkBitcoinNode(ip.split(':')[0], app.compose[0].ports[0], app.name);
  } else if (app.name === 'HavenNodeMainnet') {
    isOK = await checkHavenHeight(ip.split(':')[0], 31750);
    if (isOK) {
      isOK = await checkHavenRPC(ip.split(':')[0], 31750);
    }
  } else if (app.name === 'HavenNodeTestnet') {
    isOK = await checkHavenHeight(ip.split(':')[0], 32750);
    if (isOK) {
      isOK = await checkHavenRPC(ip.split(':')[0], 32750);
    }
  } else if (app.name === 'HavenNodeStagenet') {
    isOK = await checkHavenHeight(ip.split(':')[0], 33750);
    if (isOK) {
      isOK = await checkHavenRPC(ip.split(':')[0], 33750);
    }
  } else if (app.name.startsWith('blockbook')) {
    isOK = await checkBlockBook(ip.split(':')[0], app.compose[0].ports[0], app.name);
  } else if (app.name.startsWith('AlgorandRPC')) {
    isOK = await checkAlgorand(ip.split(':')[0], app.compose[0].ports[1]);
  } else if (app.name.toLowerCase().includes('bittensor')) {
    isOK = await checkBittensor(ip.split(':')[0], app.version >= 4 ? app.compose[0].ports[0] : app.ports[0]);
  } else if (app.name === 'alphexplorer') {
    isOK = await checkALPHexplorer(ip.split(':')[0], 9090);
  } else if (app.name === 'ergo') {
    isOK = await checkErgoHeight(ip.split(':')[0], 9053);
  } else {
    const matchIndex = ethersList.findIndex((eApp) => app.name.startsWith(eApp.name));
    if (matchIndex > -1) {
      isOK = await checkEthers(ip.split(':')[0], ethersList[matchIndex].port, ethersList[matchIndex].providerURL, ethersList[matchIndex].cmd);
    }
  }
  return isOK;
}

setInterval(async () => {
  try {
    const response = await axios.get('https://explorer.runonflux.io/api/status');
    const height = response.data.info.blocks;
    if (height > currentFluxBlockheight) {
      currentFluxBlockheight = height;
    }
  } catch (error) {
    log.error(error);
    log.error('ERROR OBTAINING FLUX HEIGHT');
  }
}, 120 * 1000);

module.exports = {
  checkMainFlux,
  checkKadenaApplication,
  checkRunOnFluxWebsite,
  checkFluxExplorer,
  checkCloudAtlasWebsite,
  checkHavenHeight,
  checkHavenRPC,
  checkKDLaunch,
  checkMOKWebsite,
  checkHavenValut,
  generalWebsiteCheck,
  checkApplication,
  applicationWithChecks,
  checkBlockBook,
  checkAlgorand,
  checkEthers,
  checkAppRunning,
  checkALPHexplorer,
  checkErgoHeight,
};

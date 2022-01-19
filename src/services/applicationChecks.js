/* eslint-disable no-unused-vars */
const axios = require('axios');
const https = require('https');
const log = require('../lib/log');

const timeout = 3456;

// MAIN
async function checkLoginPhrase(ip) {
  try {
    const { CancelToken } = axios;
    const source = CancelToken.source();
    let isResolved = false;
    setTimeout(() => {
      if (!isResolved) {
        source.cancel('Operation canceled by the user.');
      }
    }, timeout * 2);
    const url = `http://${ip}:16127/id/loginphrase`;
    const response = await axios.get(url, {
      cancelToken: source.token,
      timeout,
    });
    isResolved = true;
    if (response.data.status === 'success') {
      return true;
    }
    return false;
  } catch (error) {
    return false;
  }
}

async function isCommunicationOK(ip) {
  try {
    let { CancelToken } = axios;
    let source = CancelToken.source();
    let isResolvedA = false;
    setTimeout(() => {
      if (!isResolvedA) {
        source.cancel('Operation canceled by the user.');
      }
    }, timeout * 2);
    const urlA = `http://${ip}:16127/flux/connectedpeersinfo`;
    const urlB = `http://${ip}:16127/flux/incomingconnectionsinfo`;
    const responseA = await axios.get(urlA, {
      cancelToken: source.token,
      timeout,
    });
    isResolvedA = true;
    if (responseA.data.data.length > 8) {
      CancelToken = axios.CancelToken;
      source = CancelToken.source();
      let isResolvedB = false;
      setTimeout(() => {
        if (!isResolvedB) {
          source.cancel('Operation canceled by the user.');
        }
      }, timeout * 2);
      const responseB = await axios.get(urlB, {
        cancelToken: source.token,
        timeout,
      });
      isResolvedB = true;
      if (responseB.data.data.length > 4) {
        return true;
      }
    }
    return false;
  } catch (error) {
    return false;
  }
}

async function isHomeOK(ip) {
  try {
    const { CancelToken } = axios;
    const source = CancelToken.source();
    let isResolved = false;
    setTimeout(() => {
      if (!isResolved) {
        source.cancel('Operation canceled by the user.');
      }
    }, timeout * 2);
    const url = `http://${ip}:16126`;
    const response = await axios.get(url, {
      cancelToken: source.token,
      timeout,
    });
    isResolved = true;
    if (response.data.startsWith('<!DOCTYPE html><html')) {
      return true;
    }
    return false;
  } catch (error) {
    return false;
  }
}

async function isVersionOK(ip) {
  try {
    const { CancelToken } = axios;
    const source = CancelToken.source();
    let isResolved = false;
    setTimeout(() => {
      if (!isResolved) {
        source.cancel('Operation canceled by the user.');
      }
    }, timeout * 2);
    const url = `http://${ip}:16127/flux/version`;
    const response = await axios.get(url, {
      cancelToken: source.token,
      timeout,
    });
    isResolved = true;
    const version = response.data.data.replace(/\./g, '');
    if (version >= 321) {
      return true;
    }
    return false;
  } catch (error) {
    return false;
  }
}

async function isSyncedOK(ip) {
  try {
    const { CancelToken } = axios;
    const source = CancelToken.source();
    let isResolved = false;
    setTimeout(() => {
      if (!isResolved) {
        source.cancel('Operation canceled by the user.');
      }
    }, timeout * 2);
    const url = `http://${ip}:16127/explorer/scannedheight`;
    const response = await axios.get(url, {
      cancelToken: source.token,
      timeout,
    });
    isResolved = true;
    const version = response.data.data.generalScannedHeight;
    if (version > 1015637) {
      return true;
    }
    return false;
  } catch (error) {
    return false;
  }
}

async function hasManyApps(ip) {
  try {
    const { CancelToken } = axios;
    const source = CancelToken.source();
    let isResolved = false;
    setTimeout(() => {
      if (!isResolved) {
        source.cancel('Operation canceled by the user.');
      }
    }, timeout * 2);
    const url = `http://${ip}:16127/apps/globalappsspecifications`;
    const response = await axios.get(url, {
      cancelToken: source.token,
      timeout,
    });
    isResolved = true;
    const appsAmount = response.data.data.length;
    if (appsAmount > 400) { // we surely have at least 400 apps on network
      const fluxWhitePaper = response.data.data.find((app) => app.name === 'FluxWhitepaper'); // hopefully its on network right
      if (fluxWhitePaper.height >= 1031339) {
        return true;
      }
    }
    return false;
  } catch (error) {
    return false;
  }
}

async function checkMainFlux(ip) {
  try {
    const versionOK = await isVersionOK(ip);
    if (versionOK) {
      // eslint-disable-next-line no-await-in-loop
      const loginPhraseOK = await checkLoginPhrase(ip);
      if (loginPhraseOK) {
        // eslint-disable-next-line no-await-in-loop
        const communicationOK = await isCommunicationOK(ip);
        if (communicationOK) {
          const isSynced = await isSyncedOK(ip);
          if (isSynced) {
            const hasApps = await hasManyApps(ip);
            if (hasApps) {
              // eslint-disable-next-line no-await-in-loop
              const uiOK = await isHomeOK(ip);
              if (uiOK) {
                return true;
              }
            }
          }
        }
      }
    }
    return false;
  } catch (error) {
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
    const AConfig = {
      headers: {
        'Content-Type': 'application/json',
      },
      timeout: 3456,
    };
    const rosettaData = await axios.post(`http://${ip}:${port}/network/status`, data, AConfig);
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
    const rosettaData = await axios.post(`http://${ip}:38080/block`, data, { httpsAgent: agent, timeout: 3456 });
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
    const rosettaData = await axios.post(`http://${ip}:38080/network/status`, data, { httpsAgent: agent, timeout: 3456 });
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
  const minimumAcceptedBlockHeight = currentBlockEstimation - (60 * 20); // allow being off sync for 1200 blocks; 30 mins
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
    const goodPeersPort = peers.filter((peer) => peer.address.port !== 30004); // has outside of flux too
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
    const kadenaData = await axios.get(`https://${ip}:30004/chainweb/0.0/mainnet01/cut`, { httpsAgent: agent, timeout: 3456 });
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
    const kadenaData = await axios.get(`https://${ip}:30004/chainweb/0.0/mainnet01/cut/peer`, { httpsAgent: agent, timeout: 3456 });
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

async function checkRunOnFluxWebsite(ip) {
  try {
    const websiteResponse = await axios.get(`http://${ip}:33444`, { timeout: 8888 });
    if (websiteResponse.data.includes('<title>Flux')) {
      return true;
    }
    return false;
  } catch (error) {
    return false;
  }
}

module.exports = {
  checkMainFlux,
  checkKadenaApplication,
  checkRunOnFluxWebsite,
};

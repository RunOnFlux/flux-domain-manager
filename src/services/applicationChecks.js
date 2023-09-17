const axios = require('axios');
const https = require('https');
const log = require('../lib/log');

const axiosConfig = {
  timeout: 3456,
};

const timeout = 1200;

// MAIN
async function checkLoginPhrase(ip) {
  try {
    const url = `http://${ip}:16127/id/loginphrase`;
    const response = await axios.get(url, axiosConfig);
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
    const url = `http://${ip}:16127/flux/checkcommunication`;
    const response = await axios.get(url, axiosConfig);
    if (response.data.status === 'success') {
      return true;
    }
    return false;
  } catch (error) {
    return false;
  }
}

async function isHomeOK(ip) {
  try {
    const url = `http://${ip}:16126`;
    const response = await axios.get(url, axiosConfig);
    if (response.data.startsWith('<!DOCTYPE html><html')) {
      return true;
    }
    return false;
  } catch (error) {
    return false;
  }
}

async function checkMainFlux(ip) {
  try {
    // eslint-disable-next-line no-await-in-loop
    const loginPhraseOK = await checkLoginPhrase(ip);
    if (loginPhraseOK) {
      // eslint-disable-next-line no-await-in-loop
      const communicationOK = await isCommunicationOK(ip);
      if (communicationOK) {
        // eslint-disable-next-line no-await-in-loop
        const uiOK = await isHomeOK(ip);
        if (uiOK) {
          return true;
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
function kadenaCheckHeight(height, ip) {
  console.log(height);
  const currentTime = new Date().getTime();
  const baseTime = 1694968141000;
  const baseHeight = 81687264;
  const timeDifference = currentTime - baseTime;
  const blocksPassedInDifference = (timeDifference / 30000) * 20; // 20 chains with blocktime 30 seconds
  const currentBlockEstimation = baseHeight + blocksPassedInDifference;
  const minimumAcceptedBlockHeight = currentBlockEstimation - (60 * 40); // allow being off sync for this amount of blocks
  if (height > minimumAcceptedBlockHeight) {
    return true;
  }
  log.info(`${ip}: ${height}, min is: ${minimumAcceptedBlockHeight}`);
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
    if (kadenaCheckHeight(height, ip)) {
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

// KADENA CHAINWEB DATA
async function kadenaRecentTxs(ip) {
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
    const kadenaData = await axios.get(`http://${ip}:31352/txs/recent`, { httpsAgent: agent, timeout, cancelToken: source.token });
    isResolved = true;
    return kadenaData.data;
  } catch (e) {
    // log.error(e);
    return [];
  }
}

async function kadenaSearchTxs(ip) {
  try {
    const { CancelToken } = axios;
    const source = CancelToken.source();
    let isResolved = false;
    setTimeout(() => {
      if (!isResolved) {
        source.cancel('Operation canceled by the user.');
      }
    }, 12000 * 2);
    const kadenaData = await axios.get(`http://${ip}:31352/txs/search?search=2a3c8b18323ef7be8e28ec585d065a47925202330036a17867d85528f6720a05&offset=0&limit=100`, { timeout: 11000, cancelToken: source.token });
    isResolved = true;
    return kadenaData.data;
  } catch (e) {
    // log.error(e);
    return [];
  }
}

async function checkKadenaDataApplication(ip) {
  try {
    const currentTime = new Date().getTime();
    const searchTxs = await kadenaRecentTxs(ip);
    const lastTx = new Date(searchTxs[0].creationTime);
    const lastTimeTx = lastTx.getTime();
    const diffTen = 10 * 24 * 60 * 60 * 1000;
    if (currentTime - diffTen < lastTimeTx) {
      const searchTxsAcc = await kadenaSearchTxs(ip);
      if (searchTxsAcc.length === 100) {
        return true;
      }
      return false;
    }
    return false;
  } catch (error) {
    return false;
  }
}

module.exports = {
  checkMainFlux,
  checkKadenaApplication,
  checkKadenaDataApplication,
};

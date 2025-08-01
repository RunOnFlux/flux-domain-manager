const axios = require('axios');
const config = require('config');
const log = require('../../lib/log');

const timeout = 13456;

const axiosConfig = {
  timeout,
};

async function getFluxPermanentMessages() {
  try {
    const url = 'https://api.runonflux.io/apps/permanentmessages';
    const response = await axios.get(url);
    if (response.data.status === 'success') {
      return response.data.data;
    }
    throw new Error(response.data.data);
  } catch (error) {
    log.error(error);
    return [];
  }
}

async function getFluxList(fallback) {
  try {
    let url = `${config.explorer}/api/fluxnode/listfluxnodes`;
    if (fallback) {
      url = `${config.fallbackexplorer}/api/fluxnode/listfluxnodes`;
    }
    const { CancelToken } = axios;
    const source = CancelToken.source();
    let isResolved = false;
    setTimeout(() => {
      if (!isResolved) {
        source.cancel('Operation canceled by the user.');
      }
    }, timeout * 2);
    const fluxnodeList = await axios.get(url, {
      cancelToken: source.token,
      timeout,
    });
    isResolved = true;
    return fluxnodeList.data.result || [];
  } catch (e) {
    if (!fallback) {
      return getFluxList(true);
    }
    log.error(e);
    return [];
  }
}

async function getFluxIPs(tier) {
  try {
    let fluxnodes = await getFluxList();
    if (tier === 'STRATUS' || tier === 'NIMBUS' || tier === 'CUMULUS') {
      fluxnodes = fluxnodes.filter((fluxnode) => fluxnode.tier === tier);
    }
    const ips = fluxnodes.map((fluxnode) => fluxnode.ip);
    const correctIps = [];
    const ipvTest = /^((25[0-5]|(2[0-4]|1[0-9]|[1-9]|)[0-9])(.(?!$)|$)){4}$/;
    ips.forEach((ip) => {
      if (ipvTest.test(ip)) {
        correctIps.push(ip);
      }
    });
    return correctIps;
  } catch (e) {
    log.error(e);
    return [];
  }
}

// Retrieves application specifications from network api
async function getAppSpecifications() {
  try {
    const fluxnodeList = await axios.get(
      'https://api.runonflux.io/apps/globalappsspecifications',
      axiosConfig,
    );
    if (fluxnodeList.data.status === 'success') {
      return fluxnodeList.data.data || [];
    }
    return [];
  } catch (e) {
    log.error(e);
    return [];
  }
}
// Retrieves IP's that a given application in running on
async function getApplicationLocation(appName) {
  try {
    const fluxnodeList = await axios.get(
      `https://api.runonflux.io/apps/location/${appName}`,
      { timeout: 3_000 },
    );
    if (fluxnodeList.data.status === 'success') {
      return fluxnodeList.data.data || [];
    }
    console.log(
      `${fluxnodeList.data.status} received from getApplicationLocation`,
    );
    return [];
  } catch (e) {
    log.error(`Failed to get app location for ${appName}. ${e.message}`);
    return [];
  }
}

module.exports = {
  getFluxIPs,
  getApplicationLocation,
  getAppSpecifications,
  getFluxPermanentMessages,
};

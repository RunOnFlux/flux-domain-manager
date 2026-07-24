const axios = require('axios');
const config = require('config');
const log = require('../../lib/log');
const { parseSocketAddress, unbracket, isBareIPv6 } = require('../socketAddress');

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

const IPV4 = /^((25[0-5]|(2[0-4]|1[0-9]|[1-9]|)[0-9])(.(?!$)|$)){4}$/;

// A node address is usable if it is an address at all. The daemon reports a handful of
// empty ones, and a node on a non-default API port carries that port — which is a fact
// about the node, not a defect, so it is returned and left for callers to act on.
function isUsableNodeAddress(socketAddress) {
  if (!socketAddress) return false;
  const { host } = parseSocketAddress(socketAddress);
  return IPV4.test(unbracket(host)) || isBareIPv6(socketAddress);
}

/**
 * The socket addresses of a tier's nodes.
 *
 * The daemon calls this field `ip`, but more than half of what it returns carries a port
 * (3792 of 6541 when this was written), so these are socket addresses and are named as
 * such. Which of them a caller wants — every node, or only those on the default API port
 * — is the caller's question to ask.
 *
 * @param {string} tier
 * @returns {Promise<Array<string>>} socket addresses, some with an explicit port
 */
async function getNodeSocketAddresses(tier) {
  try {
    let fluxnodes = await getFluxList();
    if (tier === 'STRATUS' || tier === 'NIMBUS' || tier === 'CUMULUS') {
      fluxnodes = fluxnodes.filter((fluxnode) => fluxnode.tier === tier);
    }
    return fluxnodes.map((fluxnode) => fluxnode.ip).filter(isUsableNodeAddress);
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
  getNodeSocketAddresses,
  getApplicationLocation,
  getAppSpecifications,
  getFluxPermanentMessages,
};

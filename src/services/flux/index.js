const config = require('config');
const log = require('../../lib/log');
const httpClients = require('../httpClients');
const { parseSocketAddress, unbracket, isBareIPv6 } = require('../socketAddress');

const timeout = 13456;

async function getFluxList(fallback) {
  try {
    let url = `${config.explorer}/api/fluxnode/listfluxnodes`;
    if (fallback) {
      url = `${config.fallbackexplorer}/api/fluxnode/listfluxnodes`;
    }
    const fluxnodeList = await httpClients.explorer.get(url, { timeout });
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

/**
 * Where a given application is running, as the API sees it.
 *
 * `answered` is the distinction the callers need: an empty list means two
 * different things - "the API says nobody is running it" and "I could not reach
 * the API" - and only the second is worth another request. Every app the bulk
 * feed omits replies `success` with zero locations in under 200ms, so a caller
 * that cannot tell them apart spends five requests to settle one question. Same
 * distinction, and the same word, as the node probes in application/checks.js.
 *
 * @param {string} appName application name
 * @returns {Promise<{answered: boolean, locations: Object[]}>}
 */
async function getApplicationLocation(appName) {
  try {
    const fluxnodeList = await httpClients.fluxApi.get(
      `https://api.runonflux.io/apps/location/${appName}`,
      { timeout: 3_000 },
    );
    if (fluxnodeList.data.status === 'success') {
      return { answered: true, locations: fluxnodeList.data.data || [] };
    }
    console.log(
      `${fluxnodeList.data.status} received from getApplicationLocation`,
    );
    // A 200 carrying an in-band error: it replied, but not with an answer.
    return { answered: false, locations: [] };
  } catch (e) {
    log.error(`Failed to get app location for ${appName}. ${e.message}`);
    return { answered: false, locations: [] };
  }
}

module.exports = {
  getNodeSocketAddresses,
  getApplicationLocation,
};

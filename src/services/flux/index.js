const config = require('config');
const log = require('../../lib/log');
const httpClients = require('../httpClients');

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
  getFluxIPs,
  getApplicationLocation,
};

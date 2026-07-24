/* eslint-disable no-restricted-syntax */
const config = require('config');
const { resolveRouteExposure } = require('../haproxy/resolveRouteExposure');
const { effectiveRoutes } = require('./effectiveRoutes');

// The owner custom domains FDM should obtain certificates for — version-blind, from the
// resolved routes (flux-spec has already split the comma blob). A domain is included only
// when its route both terminates at FDM and is FDM-managed (Part C): v9 passthrough /
// httpOnly / owner-managed-DNS routes are skipped; legacy always qualifies. Each domain
// contributes its www. and test. variants, matching the historical expansion.
function getCustomDomains(deployment) {
  const domains = [];
  const platformSuffix = `${config.appSubDomain}.${config.mainDomain}`;
  for (const route of effectiveRoutes(deployment)) {
    if (!resolveRouteExposure(route).needsCert) {
      // eslint-disable-next-line no-continue
      continue;
    }
    for (const portDomain of route.customDomains || []) {
      if (portDomain && portDomain.includes('.') && portDomain.length >= 3 && !portDomain.toLowerCase().endsWith(platformSuffix)) {
        let domain = portDomain.replace('https://', '').replace('http://', '').replace(/[&/\\#,+()$~%'":*?<>{}]/g, ''); // . is allowed
        if (domain.includes('www.')) {
          // eslint-disable-next-line prefer-destructuring
          domain = domain.split('www.')[1];
        }
        domains.push(domain.toLowerCase());
        domains.push(`www.${domain.toLowerCase()}`);
        domains.push(`test.${domain.toLowerCase()}`);
      }
    }
  }
  return domains;
}

module.exports = {
  getCustomDomains,
};

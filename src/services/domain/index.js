/* eslint-disable no-restricted-syntax */
const config = require('config');
const log = require('../../lib/log');
const serviceHelper = require('../serviceHelper');
const specLibs = require('../flux/specLibs');
const { resolveRouteExposure } = require('../haproxy/resolveRouteExposure');
const { executeCertificateOperations } = require('./cert');
const { effectiveRoutes } = require('./effectiveRoutes');
const { DOMAIN_TYPE } = require('../constants');

// The platform FQDNs an app is reachable on — one per routed port plus the main alias —
// version-blind, sourced from the resolved loadBalancing routes rather than raw compose.
// FDM owns these (app2.runonflux.io), so they always terminate and always need a cert.
function getUnifiedDomains(deployment) {
  const lowerCaseName = deployment.appName.toLowerCase();
  const domains = effectiveRoutes(deployment).map(
    (route) => `${lowerCaseName}_${route.hostPort}.${config.appSubDomain}.${config.mainDomain}`,
  );
  // The general name is an alias to the first port.
  domains.push(`${lowerCaseName}.${config.appSubDomain}.${config.mainDomain}`);
  return domains;
}

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

async function processApplications(specifications, myFDMnameORip, myIP) {
  const processedApplications = [];
  for (const appSpecs of specifications) {
    if (config.whiteListedApps.length) {
      // exclude not whitelisted apps
      if (!serviceHelper.matchRule(appSpecs.name, config.whiteListedApps)) {
        // eslint-disable-next-line no-continue
        continue;
      }
    }
    if (config.blackListedApps.length) {
      // exclude blacklisted apps
      if (serviceHelper.matchRule(appSpecs.name, config.blackListedApps)) {
        // eslint-disable-next-line no-continue
        continue;
      }
    }

    log.info(`Adjusting domains and ssl for ${appSpecs.name}`);
    // One app must never take the batch down with it: this loop provisions certificates
    // for every app, so anything that escapes here stops routing updates for ALL of them,
    // not just the one that failed. The guard used to cover only the resolve step, which
    // left the domain rewrite above it — and the certificate work below it — unprotected.
    try {
      // eslint-disable-next-line no-await-in-loop
      const instance = await specLibs.deserialize(appSpecs);
      // eslint-disable-next-line no-await-in-loop
      const deployment = await specLibs.resolveDeployment(instance, null);

      const domains = getUnifiedDomains(deployment);
      const customDomains = getCustomDomains(deployment);
      const portLength = effectiveRoutes(deployment).length;

      if (domains.length === portLength + 1) {
        // eslint-disable-next-line no-await-in-loop
        const domainOps = await executeCertificateOperations(domains, DOMAIN_TYPE.FDM, myFDMnameORip, myIP);
        if (domainOps.success) {
          log.info(`Application domain and ssl for ${appSpecs.name} is ready`);
          processedApplications.push(appSpecs);
        } else {
          log.error(`Domain/ssl issues for ${appSpecs.name}`);
        }
        if (domainOps.success && customDomains.length) {
          // eslint-disable-next-line no-await-in-loop
          const customOps = await executeCertificateOperations(customDomains, DOMAIN_TYPE.CUSTOM, myFDMnameORip, myIP);
          if (customOps.success) {
            log.info(`Application domain and ssl for custom domains of ${appSpecs.name} is ready`);
          } else {
            log.error(`Domain/ssl issues for custom domains of ${appSpecs.name}`);
          }
        }
      } else {
        log.error(`Application ${appSpecs.name} has wierd domain, settings. This is a bug.`);
      }
    } catch (error) {
      log.error(`skipping ${appSpecs.name}: ${error.message}`);
    }
  }

  return processedApplications;
}

module.exports = {
  processApplications,
  getUnifiedDomains,
  getCustomDomains,
};

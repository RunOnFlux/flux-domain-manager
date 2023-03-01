const cloudflareConfig = require('./cloudflareConfig');
const pDNSConfig = require('./PDNSConfig');
const appsConfig = require('./appsConfig');

module.exports = {
  server: {
    port: 16130,
  },
  explorer: 'https://explorer.runonflux.io',
  fallbackexplorer: 'https://explorer.flux.zelcore.io',
  database: {
    url: '127.0.0.1',
    port: 27017,
    mainDomain: {
      database: 'runonflux',
      collections: {
        // Collection of records associated with domain
        records: 'records',
      },
    },
  },
  mainDomain: 'runonflux.io',
  domainAppType: 'CNAME',
  emailDomain: 'tessjonesie@gmail.com',
  certFolder: 'fluxapps',
  automateCertificates: true,
  automateCertificatesForFDMdomains: false,
  adjustFDMdomains: false,
  cloudflare: {
    endpoint: 'https://api.cloudflare.com/client/v4/',
    apiKey: cloudflareConfig.apiKey,
    zone: cloudflareConfig.zoneID,
    domain: cloudflareConfig.domain,
    manageapp: true,
    enabled: true,
  },
  pDNS: {
    endpoint: pDNSConfig.apiEndpoint,
    apiKey: pDNSConfig.apiKey,
    zone: pDNSConfig.zoneID,
    domain: pDNSConfig.domain,
    manageapp: false,
    enabled: false,
  },
  mandatoryApps: appsConfig.mandatoryApps,
  ownersApps: appsConfig.ownersApps, // Will retrieve only apps of owners specified here
  whiteListedApps: appsConfig.whiteListedApps, // If there's app in the array, blacklisting will be ignore
  blackListedApps: appsConfig.blackListedApps,
  appSubDomain: 'app2',
  fdmAppDomain: 'fdm-lb-2-1.runonflux.io',
  useSubset: false,
  subset: {
    start: '0',
    end: 'F',
  },
};

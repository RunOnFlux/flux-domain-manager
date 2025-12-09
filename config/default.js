const cloudflareConfig = require('./cloudflareConfig');
const pDNSConfig = require('./PDNSConfig');
const dnsGatewayConfig = require('./dnsGatewayConfig');
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
  primaryDomain: 'runonflux.com',
  domainAppType: 'CNAME',
  emailDomain: 'tadeas@runonflux.io',
  certFolder: 'fluxapps',
  manageCertificateOnly: true,
  automateCertificates: false,
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
  dnsGateway: {
    endpoint: dnsGatewayConfig.endpoint,
    certPath: dnsGatewayConfig.certPath,
    keyPath: dnsGatewayConfig.keyPath,
    caPath: dnsGatewayConfig.caPath,
    timeout: dnsGatewayConfig.timeout,
    enabled: dnsGatewayConfig.enabled,
  },
  mandatoryApps: appsConfig.mandatoryApps,
  ownersApps: appsConfig.ownersApps, // Will retrieve only apps of owners specified here
  whiteListedApps: appsConfig.whiteListedApps, // If there's app in the array, blacklisting will be ignore
  blackListedApps: appsConfig.blackListedApps,
  minecraftApps: appsConfig.minecraftApps,
  directDNSGameApps: appsConfig.directDNSGameApps, // Games that need direct DNS routing (bypass HAProxy for player traffic)
  appSubDomain: 'app2',
  fdmAppDomain: 'fdm-lb-2-1.runonflux.io',
  uiName: 'home',
  apiName: 'api',
  useSubset: false,
  subset: {
    start: '0',
    end: 'F',
  },
};

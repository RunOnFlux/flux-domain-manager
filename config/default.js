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
  appSubDomain: 'app2',
  fdmAppDomain: 'fdm-lb-2.runonflux.io',
  domainAppType: 'CNAME',
  emailDomain: 'tessjonesie@gmail.com',
  certFolder: 'fluxapps',
  automateCertificates: true,
  automateCertificatesForFDMdomains: false,
  cloudflare: {
    endpoint: 'https://api.cloudflare.com/client/v4/',
    apiKey: cloudflareConfig.apiKey,
    zone: cloudflareConfig.zoneID,
    domain: cloudflareConfig.domain,
    manageapp: false,
    enabled: false,
  },
  pDNS: {
    endpoint: pDNSConfig.apiEndpoint,
    apiKey: pDNSConfig.apiKey,
    zone: pDNSConfig.zoneID,
    domain: pDNSConfig.domain,
    manageapp: true,
    enabled: true,
  },
<<<<<<< HEAD
  mandatoryApps: appsConfig.mandatoryApps,
  ownersApps: appsConfig.ownersApps, // Will retrieve only apps of owners specified here
  whiteListedApps: appsConfig.whiteListedApps, // If there's app in the array, blacklisting will be ignore
  blackListedApps: appsConfig.blackListedApps,

  subset: {
    type: 'BUCKET',
    config: {
      total: 4,
      bucket: 0,
    },
  },
=======
  mandatoryApps: ['explorer', 'KDLaunch', 'website', 'Kadena3', 'Kadena4', 'HavenNodeMainnet'],
  ownersApps: [], // Will retrieve only apps of owners specified here
  whiteListedApps: [], // If there's app in the array, blacklisting will be ignore
  blackListedApps: ['Kadena', 'Kadena2', 'firefox', 'firefoxtest', 'firefox2', 'apponflux', 'appononflux', 'testapponflux', 'mysqlonflux', 'mysqlfluxmysql', 'application', 'applicationapplication', 'PresearchNode*', 'FiroNode*'],
  // subset: {
  //   type: 'BUCKET',
  //   config: {
  //     total: 2,
  //     bucket: 0,
  //   },
  // },
>>>>>>> finalize proxy and config
};

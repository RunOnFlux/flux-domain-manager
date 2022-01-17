const cloudflareConfig = require('./cloudflareConfig');
const pDNSConfig = require('./PDNSConfig');

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
  emailDomain: 'tessjonesie@gmail.com',
  certFolder: 'fluxapps',
  automateCertificates: false,
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
  blackListedApps: ['firefox', 'firefoxtest', 'firefox2', 'apponflux', 'appononflux', 'testapponflux', 'mysqlonflux', 'mysqlfluxmysql', 'application', 'applicationapplication', 'PresearchNode*', 'FiroNode*'],
};

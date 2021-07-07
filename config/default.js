const cloudflareConfig = require('./cloudflareConfig');

module.exports = {
  server: {
    port: 9988,
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
  cloudflare: {
    endpoint: 'https://api.cloudflare.com/client/v4/',
    apiKey: cloudflareConfig.apiKey,
    zone: cloudflareConfig.zoneID,
    domain: cloudflareConfig.domain,
    manageapp: true,
  },
};

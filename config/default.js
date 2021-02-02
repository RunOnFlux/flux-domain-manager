module.exports = {
  server: {
    port: 9988,
  },
  explorer: 'https://explorer.zel.network',
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
};

const appsConfig = require('./appsConfig');
const customConfigs = require('./customConfigs');
const haproxyRouting = require('./haproxyRouting');
const specDecrypt = require('./specDecrypt');
const domainOverrides = require('./domainOverrides');
const sharedDbRouting = require('./sharedDbRouting');
const appChecks = require('./appChecks');
const staticLocations = require('./staticLocations');

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
  emailDomain: 'tadeas@runonflux.io',
  certFolder: 'fluxapps',
  certRenewalPrimary: false,
  // true: this FDM routes applications under appSubDomain.mainDomain
  // false: it routes the main node domain instead
  manageApps: true,
  mandatoryApps: appsConfig.mandatoryApps,
  ownersApps: appsConfig.ownersApps, // Will retrieve only apps of owners specified here
  whiteListedApps: appsConfig.whiteListedApps, // If there's app in the array, blacklisting will be ignore
  blackListedApps: appsConfig.blackListedApps,
  minecraftApps: appsConfig.minecraftApps,
  customConfigs,
  haproxyRouting,
  specDecrypt,
  domainOverrides,
  sharedDbRouting,
  appChecks,
  staticLocations,
  appSubDomain: 'app2',
  fdmAppDomain: 'fdm-lb-2-1.runonflux.io',
  uiName: 'home',
  cloudUiName: 'cloud',
  apiName: 'api',
  useSubset: false,
  subset: {
    start: '0',
    end: 'F',
  },
};

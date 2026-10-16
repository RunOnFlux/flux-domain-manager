'use strict';

const appsConfig = require('./appsConfig');
const guardsConfig = require('./guardsConfig');
const customConfigs = require('./customConfigs');
const haproxyRouting = require('./haproxyRouting');
const cryptoService = require('./cryptoService');
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
  // fluxd's name for the chain the app specs are registered on: 'main' or 'labnet'
  chain: 'main',
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
  guards: guardsConfig,
  alerts: {
    // Discord webhook for operator alerts; empty sends nothing.
    discordWebhookUrl: '',
  },
  customConfigs,
  haproxyRouting,
  cryptoService,
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

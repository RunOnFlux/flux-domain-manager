/* eslint-disable prefer-destructuring */
/* eslint-disable no-restricted-syntax */
const config = require('config');
const fs = require('fs').promises;
const log = require('../lib/log');
const ipService = require('./ipService');
const fluxService = require('./flux');
const haproxyTemplate = require('./haproxyTemplate');
const {
  processApplications,
  getUnifiedDomains,
  getCustomDomains,
} = require('./domain');
const { executeCertificateOperations } = require('./domain/cert');
const applicationChecks = require('./application/checks');
const { getCustomConfigs } = require('./application/custom');
const { getApplicationsToProcess } = require('./application/subset');
const { DOMAIN_TYPE } = require('./constants');
const { startCertRsync } = require('./rsync');
const serviceHelper = require('./serviceHelper');

const { FdmDataFetcher } = require('./flux/dataFetcher');

let myIP = null;
let myFDMnameORip = null;

let unifiedAppsDomains = [];
const mapOfNamesIps = {};
let recentlyConfiguredApps = null;
let recentlyConfiguredGApps = null;
let permanentMessages = [];
let lastHaproxyAppsConfig = [];
let gAppsProcessingFinishedOnce = false;
let nonGAppsProcessingFinishedOnce = false;
let dataFetcher = null;

async function checkDomainOwnership(domain, appName) {
  try {
    if (!domain) {
      return true;
    }
    const filteredDomains = unifiedAppsDomains.filter((entry) => entry.domains.includes(domain.toLowerCase()));
    const ourAppExists = filteredDomains.find(
      (existing) => existing.name === appName,
    );
    if (filteredDomains.length >= 2 && ourAppExists) {
      // we have multiple apps that has the same domain assigned;
      // check permanent messages for these apps
      const appNames = [];
      filteredDomains.forEach((x) => {
        appNames.push(x.name);
      });
      // now we have only the messages that touch the apps that have the domain
      const filteredPermanentMessages = permanentMessages.filter((mes) => appNames.includes(mes.appSpecifications.name));
      const adjustedFilteredPermMessages = [];
      filteredPermanentMessages.forEach((message) => {
        const stringedMessage = JSON.stringify(message).toLowerCase();
        if (stringedMessage.includes(domain.toLowerCase())) {
          adjustedFilteredPermMessages.push(message);
        }
      });
      const sortedPermanentFilteredMessages = adjustedFilteredPermMessages.sort(
        (a, b) => {
          if (a.height < b.height) return -1;
          if (a.height > b.height) return 1;
          return 0;
        },
      );
      const oldestMessage = sortedPermanentFilteredMessages[0];
      if (oldestMessage.appSpecifications.name === appName) {
        return true;
      }
      log.warn(`Custom domain ${domain} not owned by ${appName}`);
      return false;
    }
    return true;
  } catch (error) {
    return true;
  }
}

// Generates config file for HAProxy
let fluxIPsForBalancing = [];
async function generateAndReplaceMainHaproxyConfig() {
  try {
    const ui = `${config.uiName}.${config.mainDomain}`;
    const api = `${config.apiName}.${config.mainDomain}`;
    let uiPrimary;
    let apiPrimary;
    if (config.primaryDomain) {
      uiPrimary = `${config.uiName}.${config.primaryDomain}`;
      apiPrimary = `${config.apiName}.${config.primaryDomain}`;
    }

    const fluxIPs = (await fluxService.getFluxIPs('STRATUS')).filter(
      (ip) => !ip.split(':')[1],
    ); // use only stratus for home and on default api port
    if (fluxIPs.length < 100) {
      throw new Error('Invalid Flux List');
    }

    const aux = fluxIPsForBalancing.length;

    fluxIPsForBalancing = fluxIPsForBalancing.filter((ip) => fluxIPs.includes(ip));

    for (const ip of fluxIPsForBalancing) {
      // eslint-disable-next-line no-await-in-loop
      const isOK = await applicationChecks.checkMainFlux(
        ip.split(':')[0],
        ip.split(':')[1],
      ); // can be undefined
      if (!isOK) {
        const index = fluxIPsForBalancing.indexOf(ip);
        if (index > -1) {
          // only splice array when item is found
          fluxIPsForBalancing.splice(index, 1); // 2nd parameter means remove one item only
          console.log(`removing ${ip} as backend`);
        }
      }
    }

    if (aux !== fluxIPsForBalancing.length && fluxIPsForBalancing.length > 0) {
      // lets remove already the nodes not ok before looking for new ones
      console.log(
        `Removing some nodes from backend that are no longer ok: ${
          aux - fluxIPsForBalancing.length
        }`,
      );
      const hc = await haproxyTemplate.createMainHaproxyConfig(
        ui,
        api,
        fluxIPsForBalancing,
        uiPrimary,
        apiPrimary,
      );
      console.log(hc);
      const dataToWrite = hc;
      // test haproxy config
      const successRestart = await haproxyTemplate.restartProxy(dataToWrite);
      if (!successRestart) {
        throw new Error('Invalid HAPROXY Config File!');
      }
    }

    console.log(`Current Ips on backend ${fluxIPsForBalancing.length}`);

    // we want to do some checks on UI and API to verify functionality
    // 1st check is loginphrase
    // 2nd check is communication
    // 3rd is ui
    if (fluxIPsForBalancing.length <= 100) {
      console.log(`Found ${fluxIPs.length} STRATUS on default api port`);
      for (const ip of fluxIPs) {
        if (fluxIPsForBalancing.indexOf(ip) >= 0) {
          // eslint-disable-next-line no-continue
          continue;
        }
        // eslint-disable-next-line no-await-in-loop
        const isOK = await applicationChecks.checkMainFlux(
          ip.split(':')[0],
          ip.split(':')[1],
        ); // can be undefined
        if (isOK) {
          fluxIPsForBalancing.push(ip);
          console.log(`adding ${ip} as backend`);
        }
        if (fluxIPsForBalancing.length > 100) {
          // maximum of 100 for load balancing
          break;
        }
      }
    }

    if (fluxIPsForBalancing.length < 10) {
      throw new Error('Not enough ok nodes, probably error');
    }
    const hc = await haproxyTemplate.createMainHaproxyConfig(
      ui,
      api,
      fluxIPsForBalancing,
      uiPrimary,
      apiPrimary,
    );
    console.log(hc);
    const dataToWrite = hc;
    // test haproxy config
    const successRestart = await haproxyTemplate.restartProxy(dataToWrite);
    if (!successRestart) {
      throw new Error('Invalid HAPROXY Config File!');
    }
    setTimeout(() => {
      generateAndReplaceMainHaproxyConfig();
    }, 30 * 1000);
  } catch (error) {
    log.error(error);
    setTimeout(() => {
      generateAndReplaceMainHaproxyConfig();
    }, 30 * 1000);
  }
}

async function createSSLDirectory() {
  const dir = `/etc/ssl/${config.certFolder}`;
  await fs.mkdir(dir, { recursive: true });
}

function filterMandatoryApps(apps) {
  const subsetConfig = config.subset;
  const startCode = subsetConfig.start.charCodeAt(0);
  const endCode = subsetConfig.end.charCodeAt(0);

  const appsInBucket = [];
  // eslint-disable-next-line no-restricted-syntax
  for (const app of apps) {
    const charCode = app.toUpperCase().charCodeAt(0);
    if (charCode >= startCode && charCode <= endCode) {
      appsInBucket.push(app);
    }
  }

  return appsInBucket;
}

async function selectIPforG(ips, app) {
  // choose the ip address whose sum of digits is the lowest
  if (ips && ips.length) {
    let chosenIp = ips[0];
    let chosenIpSum = ips[0]
      .split(':')[0]
      .split('.')
      .reduce((a, b) => parseInt(a, 10) + parseInt(b, 10), 0);
    for (const ip of ips) {
      const sum = ip
        .split(':')[0]
        .split('.')
        .reduce((a, b) => parseInt(a, 10) + parseInt(b, 10), 0);
      if (sum < chosenIpSum) {
        chosenIp = ip;
        chosenIpSum = sum;
      }
    }
    if (ips.includes(mapOfNamesIps[app.name])) {
      chosenIp = mapOfNamesIps[app.name];
    } else {
      mapOfNamesIps[app.name] = chosenIp;
    }
    const isOk = await applicationChecks.checkAppRunning(chosenIp, app.name);
    if (isOk) {
      return chosenIp;
    }
    const newIps = ips.filter((ip) => ip !== chosenIp);
    if (newIps.length) {
      return selectIPforG(newIps, app);
    }
  }
  return null;
}

let appIpsOnAppsChecks = [];
async function addAppIps(app, ip) {
  const isCheckOK = await applicationChecks.checkApplication(app, ip);
  if (isCheckOK) {
    appIpsOnAppsChecks.push(ip);
  }
}

/**
 * To delay by a number of milliseconds.
 * @param {number} ms Number of milliseconds.
 * @returns {Promise} Promise object.
 */
function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

let updateHaproxyRunning = false;
async function updateHaproxy(haproxyAppsConfig) {
  try {
    if (updateHaproxyRunning) {
      await delay(1000);
      await updateHaproxy(haproxyAppsConfig);
      return;
    }
    updateHaproxyRunning = true;
    const hc = await haproxyTemplate.createAppsHaproxyConfig(haproxyAppsConfig);
    console.log(hc);
    const dataToWrite = hc;
    // test haproxy config
    const successRestart = await haproxyTemplate.restartProxy(dataToWrite);
    if (!successRestart) {
      throw new Error('Invalid HAPROXY Config File!');
    }
  } finally {
    updateHaproxyRunning = false;
  }
}

function addConfigurations(configuredApps, app, appIps, gMode) {
  const domains = getUnifiedDomains(app);
  const customConfigs = getCustomConfigs(app, gMode);
  let timeout = null;
  if (app.version <= 3) {
    const timeoutConfig = app.enviromentParameters.find((att) => att.toLowerCase().startsWith('timeout='));
    if (timeoutConfig) {
      timeout = timeoutConfig.split('=')[1];
    }
    for (let i = 0; i < app.ports.length; i += 1) {
      const configuredApp = {
        name: app.name,
        appName: `${app.name}_${app.ports[i]}`,
        domain: domains[i],
        port: app.ports[i],
        ips: appIps,
        isRdata: app.isRdata,
        ...customConfigs[i],
        timeout,
      };

      configuredApps.push(configuredApp);
      if (app.domains[i]) {
        const portDomains = app.domains[i].split(',');
        for (let portDomain of portDomains) {
          // eslint-disable-next-line no-param-reassign
          portDomain = portDomain
            .replace('https://', '')
            .replace('http://', '')
            .replace(/[&/\\#,+()$~%'":*?<>{}]/g, ''); // . is allowed
          const isDomainAllowed = checkDomainOwnership(portDomain, app.name);
          if (isDomainAllowed === false) {
            // eslint-disable-next-line no-continue
            continue;
          }
          // TODO here check on permanent apps if this app name is true owner of the portDomain
          if (portDomain.includes('www.')) {
            // eslint-disable-next-line prefer-destructuring, no-param-reassign
            portDomain = portDomain.split('www.')[1];
          }
          // prevention for double backend on custom domains, can be improved
          const domainAssigned = configuredApps.find(
            (appThatIsConfigured) => appThatIsConfigured.domain === portDomain,
          );
          if (
            portDomain
            && portDomain.includes('.')
            && portDomain.length > 3
            && !portDomain
              .toLowerCase()
              .includes(
                `${config.appSubDomain}.${config.mainDomain.split('.')[0]}`,
              )
            && !domainAssigned
          ) {
            // prevent double backend
            const domainExists = configuredApps.find(
              (a) => a.domain === portDomain.toLowerCase(),
            );
            if (!domainExists) {
              const configuredAppCustom = {
                name: app.name,
                appName: `${app.name}_${app.ports[i]}`,
                domain: portDomain,
                port: app.ports[i],
                ips: appIps,
                isRdata: app.isRdata,
                ...customConfigs[i],
                timeout,
              };
              configuredApps.push(configuredAppCustom);
            }
            const wwwAdjustedDomain = `www.${portDomain.toLowerCase()}`;
            if (wwwAdjustedDomain) {
              const domainExistsB = configuredApps.find(
                (a) => a.domain === wwwAdjustedDomain,
              );
              if (!domainExistsB) {
                const configuredAppCustom = {
                  name: app.name,
                  appName: `${app.name}_${app.ports[i]}`,
                  domain: wwwAdjustedDomain,
                  port: app.ports[i],
                  ips: appIps,
                  isRdata: app.isRdata,
                  ...customConfigs[i],
                  timeout,
                };
                configuredApps.push(configuredAppCustom);
              }
            }

            const testAdjustedDomain = `test.${portDomain.toLowerCase()}`;
            if (testAdjustedDomain) {
              const domainExistsB = configuredApps.find(
                (a) => a.domain === testAdjustedDomain,
              );
              if (!domainExistsB) {
                const configuredAppCustom = {
                  name: app.name,
                  appName: `${app.name}_${app.ports[i]}`,
                  domain: testAdjustedDomain,
                  port: app.ports[i],
                  ips: appIps,
                  isRdata: app.isRdata,
                  ...customConfigs[i],
                  timeout,
                };
                configuredApps.push(configuredAppCustom);
              }
            }
          }
        }
      }
    }
    const mainApp = {
      name: app.name,
      appName: `${app.name}_${app.ports[0]}`,
      domain: domains[domains.length - 1],
      port: app.ports[0],
      ips: appIps,
      isRdata: app.isRdata,
      ...customConfigs[customConfigs.length - 1],
      timeout,
    };
    configuredApps.push(mainApp);
  } else {
    let j = 0;
    for (const component of app.compose) {
      timeout = null;
      const timeoutConfig = component.environmentParameters.find((att) => att.toLowerCase().startsWith('timeout='));
      if (timeoutConfig) {
        timeout = timeoutConfig.split('=')[1];
      }
      for (let i = 0; i < component.ports.length; i += 1) {
        const configuredApp = {
          name: app.name,
          appName: `${app.name}_${component.name}_${component.ports[i]}`,
          domain: domains[j],
          port: component.ports[i],
          ips: appIps,
          isRdata: app.isRdata,
          ...customConfigs[j],
          timeout,
        };
        configuredApps.push(configuredApp);
        const portDomains = component.domains[i].split(',');
        // eslint-disable-next-line no-loop-func
        for (let portDomain of portDomains) {
          // eslint-disable-next-line no-param-reassign
          portDomain = portDomain
            .replace('https://', '')
            .replace('http://', '')
            .replace(/[&/\\#,+()$~%'":*?<>{}]/g, ''); // . is allowed
          const isDomainAllowed = checkDomainOwnership(portDomain, app.name);
          if (isDomainAllowed === false) {
            // eslint-disable-next-line no-continue
            continue;
          }
          if (portDomain.includes('www.')) {
            // eslint-disable-next-line prefer-destructuring, no-param-reassign
            portDomain = portDomain.split('www.')[1];
          }
          // prevention for double backend on custom domains, can be improved
          const domainAssigned = configuredApps.find(
            (appThatIsConfigured) => appThatIsConfigured.domain === portDomain,
          );
          if (
            portDomain
            && portDomain.includes('.')
            && portDomain.length >= 3
            && !portDomain
              .toLowerCase()
              .includes(
                `${config.appSubDomain}.${config.mainDomain.split('.')[0]}`,
              )
            && !domainAssigned
          ) {
            if (
              !portDomain.includes(
                `${config.appSubDomain}${config.mainDomain.split('.')[0]}`,
              )
            ) {
              // prevent double backend
              const domainExists = configuredApps.find(
                (a) => a.domain === portDomain.toLowerCase(),
              );
              if (!domainExists) {
                const configuredAppCustom = {
                  name: app.name,
                  appName: `${app.name}_${component.name}_${component.ports[i]}`,
                  domain: portDomain,
                  port: component.ports[i],
                  ips: appIps,
                  isRdata: app.isRdata,
                  ...customConfigs[j],
                  timeout,
                };
                configuredApps.push(configuredAppCustom);
              }

              const wwwAdjustedDomain = `www.${portDomain.toLowerCase()}`;
              if (wwwAdjustedDomain) {
                const domainExistsB = configuredApps.find(
                  (a) => a.domain === wwwAdjustedDomain,
                );
                if (!domainExistsB) {
                  const configuredAppCustom = {
                    name: app.name,
                    appName: `${app.name}_${component.name}_${component.ports[i]}`,
                    domain: wwwAdjustedDomain,
                    port: component.ports[i],
                    ips: appIps,
                    isRdata: app.isRdata,
                    ...customConfigs[j],
                    timeout,
                  };
                  configuredApps.push(configuredAppCustom);
                }
              }

              const testAdjustedDomain = `test.${portDomain.toLowerCase()}`;
              if (testAdjustedDomain) {
                const domainExistsB = configuredApps.find(
                  (a) => a.domain === testAdjustedDomain,
                );
                if (!domainExistsB) {
                  const configuredAppCustom = {
                    name: app.name,
                    appName: `${app.name}_${component.name}_${component.ports[i]}`,
                    domain: testAdjustedDomain,
                    port: component.ports[i],
                    ips: appIps,
                    isRdata: app.isRdata,
                    ...customConfigs[j],
                    timeout,
                  };
                  configuredApps.push(configuredAppCustom);
                }
              }
            }
          }
        }
        j += 1;
      }
    }
    // push main domain
    for (let q = 0; q < app.compose.length; q += 1) {
      for (let w = 0; w < app.compose[q].ports.length; w += 1) {
        const mainDomainExists = configuredApps.find(
          (qw) => qw.domain === domains[domains.length - 1],
        );
        if (!mainDomainExists) {
          const mainApp = {
            name: app.name,
            appName: `${app.name}_${app.compose[q].name}_${app.compose[q].ports[w]}`,
            domain: domains[domains.length - 1],
            port: app.compose[q].ports[w],
            ips: appIps,
            isRdata: app.isRdata,
            ...customConfigs[customConfigs.length - 1],
          };
          configuredApps.push(mainApp);
        }
      }
    }
  }
}

/**
 *
 * @param {Map<string, Object>} globalAppSpecs Pre filtered NonG Applications
 */
async function generateAndReplaceMainApplicationHaproxyConfig(globalAppSpecsMap) {
  try {
    log.info(`Non G Mode STARTED at${new Date()}`);

    // just use the map in the future
    const globalAppSpecs = globalAppSpecsMap.values();

    // filter applications based on config
    const applicationSpecifications = getApplicationsToProcess(globalAppSpecs);

    // for every application do following
    // get name, ports
    // main application domain is name.app.domain, for every port we have name-port.app.domain
    // check and adjust dns record for missing domains
    // obtain certificate
    // add to renewal script
    // check if certificate exist
    // if all ok, add for creation of domain
    await createSSLDirectory();
    log.info('SSL directory checked');
    const appsOK = await processApplications(
      applicationSpecifications,
      myFDMnameORip,
      myIP,
    );
    // check appsOK against mandatoryApps
    let { mandatoryApps } = config;
    if (config.useSubset) {
      mandatoryApps = filterMandatoryApps(mandatoryApps);
    }
    for (const mandatoryApp of mandatoryApps) {
      const appExists = appsOK.find((app) => app.name === mandatoryApp);
      if (!appExists) {
        throw new Error(`Mandatory app ${mandatoryApp} does not exist. PANIC`);
      }
    }
    // continue with appsOK
    const configuredApps = []; // object of domain, port, ips for backend and isRdata
    for (const app of appsOK) {
      log.info(`Configuring ${app.name}`);
      // eslint-disable-next-line no-await-in-loop
      let appLocations = await fluxService.getApplicationLocation(app.name);
      let appLocationsSearchNumber = 0;
      while (appLocations.length === 0 && appLocationsSearchNumber < 5) {
        log.info(`No apps locations found for application ${app.name}`);
        appLocationsSearchNumber += 1;
        // eslint-disable-next-line no-await-in-loop
        appLocations = await fluxService.getApplicationLocation(app.name);
      }
      if (app.name === 'blockbookbitcoin') {
        appLocations.push({ ip: '[2001:41d0:d00:b800::20]:9130' });
        appLocations.push({ ip: '[2001:41d0:d00:b800::21]:9130' });
      }
      if (app.name === 'blockbooklitecoin') {
        appLocations.push({ ip: '[2001:41d0:d00:b800::24]:9134' });
        appLocations.push({ ip: '[2001:41d0:d00:b800::25]:9134' });
      }
      if (app.name === 'blockbookdogecoin') {
        appLocations.push({ ip: '[2001:41d0:d00:b800::36]:9138' });
        appLocations.push({ ip: '[2001:41d0:d00:b800::37]:9138' });
      }
      if (app.name === 'blockbookravencoin') {
        appLocations.push({ ip: '[2001:41d0:d00:b800::46]:9159' });
        appLocations.push({ ip: '[2001:41d0:d00:b800::47]:9159' });
      }
      if (app.name === 'blockbookbitcointestnet') {
        appLocations.push({ ip: '[2001:41d0:d00:b800::42]:19129' });
        appLocations.push({ ip: '[2001:41d0:d00:b800::43]:19129' });
      }
      if (app.name === 'blockbookbitcoinsignet') {
        appLocations.push({ ip: '[2001:41d0:d00:b800::97]:19120' });
        appLocations.push({ ip: '[2001:41d0:d00:b800::98]:19120' });
      }
      if (app.name === 'blockbookzcash') {
        appLocations.push({ ip: '[2001:41d0:d00:b800::26]:9132' });
        appLocations.push({ ip: '[2001:41d0:d00:b800::27]:9132' });
      }
      if (app.name === 'blockbookbitcoincash') {
        appLocations.push({ ip: '[2001:41d0:d00:b800::91]:9131' });
        appLocations.push({ ip: '[2001:41d0:d00:b800::92]:9131' });
      }
      if (appLocations.length > 0) {
        let appIps = [];
        app.isRdata = false;
        const applicationWithChecks = applicationChecks.applicationWithChecks(app);
        if (applicationWithChecks) {
          let promiseArray = [];
          for (const [i, location] of appLocations.entries()) {
            // run coded checks for app
            promiseArray.push(addAppIps(app, location.ip));
            if ((i + 1) % 10 === 0) {
              // eslint-disable-next-line no-await-in-loop
              await Promise.allSettled(promiseArray);
              promiseArray = [];
              if (app.name === 'explorer') {
                log.info(appIpsOnAppsChecks);
              }
              // eslint-disable-next-line no-loop-func
              appIpsOnAppsChecks.forEach((loc) => {
                appIps.push(loc);
              });
              appIpsOnAppsChecks = [];
            }
          }
          if (promiseArray.length > 0) {
            // eslint-disable-next-line no-await-in-loop
            await Promise.allSettled(promiseArray);
            promiseArray = [];
            if (app.name === 'explorer') {
              log.info(appIpsOnAppsChecks);
            }
            appIpsOnAppsChecks.forEach((loc) => {
              appIps.push(loc);
            });
            appIpsOnAppsChecks = [];
          }
        } else if (
          app.compose
          && app.compose.find((comp) => comp.repotag.toLowerCase().includes('runonflux/shared-db'))
        ) {
          // app using sharedDB project
          app.isRdata = true;
          appIps = appLocations.map((location) => location.ip);
          const componentUsingSharedDB = app.compose.find((comp) => comp.repotag.toLowerCase().includes('runonflux/shared-db'));
          log.info(`sharedDBApps: Found app ${app.name} using sharedDB`);
          if (
            componentUsingSharedDB.ports
            && componentUsingSharedDB.ports.length > 0
          ) {
            const apiPort = componentUsingSharedDB.ports[
              componentUsingSharedDB.ports.length - 1
            ]; // it's the last port from the shareddb that is the api port
            let operatorClusterStatus = null;
            const httpTimeout = 5000;
            // eslint-disable-next-line no-await-in-loop
            for (const ip of appIps) {
              const url = `http://${ip.split(':')[0]}:${apiPort}/status`;
              log.info(
                `sharedDBApps: ${app.name} going to check operator status on url ${url}`,
              );
              // eslint-disable-next-line no-await-in-loop
              const operatorStatus = await serviceHelper
                .httpGetRequest(url, httpTimeout)
                .catch((error) => log.error(
                  `sharedDBApps: ${app.name} operatorStatus error: ${error}`,
                ));
              if (
                operatorStatus
                && operatorStatus.data
                && operatorStatus.data.status === 'OK'
              ) {
                operatorClusterStatus = operatorStatus.data.clusterStatus.map(
                  (cluster) => cluster.ip,
                );
                break;
              }
            }
            if (operatorClusterStatus) {
              appIps.sort(
                (a, b) => operatorClusterStatus.indexOf(a)
                  - operatorClusterStatus.indexOf(b),
              );
              log.info(`Application ${app.name} was setup as a sharedDBApps`);
            } else {
              appIps.sort((a, b) => {
                if (!a.runningSince && b.runningSince) {
                  return -1;
                }
                if (a.runningSince && !b.runningSince) {
                  return 1;
                }
                if (a.runningSince < b.runningSince) {
                  return -1;
                }
                if (a.runningSince > b.runningSince) {
                  return 1;
                }
                if (a.ip < b.ip) {
                  return -1;
                }
                if (a.ip > b.ip) {
                  return 1;
                }
                return 0;
              });
            }
            // lets remove db and operator from haproxy
            const componentUsingSharedDBIndex = app.compose.findIndex((comp) => comp.repotag.toLowerCase().includes('runonflux/shared-db'));
            const componentMySQLIndex = app.compose.findIndex((comp) => comp.repotag.toLowerCase().includes('mysql'));
            if (componentUsingSharedDBIndex >= 0) {
              app.compose[componentUsingSharedDBIndex].ports = app.compose[componentUsingSharedDBIndex].ports.slice(-1);
            }
            if (componentMySQLIndex >= 0) {
              app.compose.splice(componentMySQLIndex, 1);
            }
          } else if (
            (app.version <= 3 && app.containerData.includes('r:'))
            || (app.compose
              && app.compose.find((comp) => comp.containerData.includes('r:')))
          ) {
            app.isRdata = true;
            appIps.sort((a, b) => {
              if (!a.runningSince && b.runningSince) {
                return -1;
              }
              if (a.runningSince && !b.runningSince) {
                return 1;
              }
              if (a.runningSince < b.runningSince) {
                return -1;
              }
              if (a.runningSince > b.runningSince) {
                return 1;
              }
              if (a.ip < b.ip) {
                return -1;
              }
              if (a.ip > b.ip) {
                return 1;
              }
              return 0;
            });
          }
        } else {
          appIps = appLocations.map((location) => location.ip);
        }
        if (app.name === 'explorer') {
          log.info(appIps);
        }
        if (config.mandatoryApps.includes(app.name) && appIps.length < 1) {
          throw new Error(`Application ${app.name} checks not ok. PANIC.`);
        }
        addConfigurations(configuredApps, app, appIps, false);
        log.info(
          `Application ${app.name} with specific checks: ${applicationWithChecks} is OK. Proceeding to FDM`,
        );
      } else {
        log.warn(`Application ${app.name} is excluded. Not running properly?`);
        if (config.mandatoryApps.includes(app.name)) {
          throw new Error(`Application ${app.name} is not running well PANIC.`);
        }
      }
    }

    if (configuredApps.length < 10) {
      throw new Error('PANIC PLEASE DEV HELP ME');
    }

    if (
      JSON.stringify(configuredApps) === JSON.stringify(recentlyConfiguredApps)
    ) {
      log.info('No changes in Non G Mode configuration detected');
    } else {
      log.info('Changes in Non G Mode configuration detected');
    }
    let haproxyAppsConfig = [];
    recentlyConfiguredApps = configuredApps;
    nonGAppsProcessingFinishedOnce = true;
    if (gAppsProcessingFinishedOnce) {
      haproxyAppsConfig = configuredApps.concat(recentlyConfiguredGApps); // we need to put always in same order to avoid. non g first g at end
    }

    if (
      nonGAppsProcessingFinishedOnce
      && gAppsProcessingFinishedOnce
      && JSON.stringify(lastHaproxyAppsConfig)
        !== JSON.stringify(haproxyAppsConfig)
    ) {
      log.info(
        `Non G Mode updating haproxy with lenght: ${haproxyAppsConfig.length}`,
      );
      lastHaproxyAppsConfig = haproxyAppsConfig;
      await updateHaproxy(haproxyAppsConfig);
    }
  } catch (error) {
    log.error(error);
  } finally {
    log.info(`Non G Mode ENDED at${new Date()}`);
  }
}

async function generateAndReplaceMainApplicationHaproxyGAppsConfig(
  globalAppSpecsMap,
) {
  try {
    log.info(`G Mode STARTED at${new Date()}`);

    const globalAppSpecs = globalAppSpecsMap.values();

    // filter applications based on config
    const applicationSpecifications = getApplicationsToProcess(globalAppSpecs);

    // for every application do following
    // get name, ports
    // main application domain is name.app.domain, for every port we have name-port.app.domain
    // check and adjust dns record for missing domains
    // obtain certificate
    // add to renewal script
    // check if certificate exist
    // if all ok, add for creation of domain
    await createSSLDirectory();
    log.info('SSL directory checked');
    const appsOK = await processApplications(
      applicationSpecifications,
      myFDMnameORip,
      myIP,
    );

    // continue with appsOK
    const configuredApps = []; // object of domain, port, ips for backend and isRdata
    for (const app of appsOK) {
      log.info(`Configuring ${app.name}`);
      // eslint-disable-next-line no-await-in-loop
      let appLocations = await fluxService.getApplicationLocation(app.name);
      let appLocationsSearchNumber = 0;
      while (appLocations.length === 0 && appLocationsSearchNumber < 5) {
        log.info(`No apps locations found for application ${app.name}`);
        appLocationsSearchNumber += 1;
        // eslint-disable-next-line no-await-in-loop
        appLocations = await fluxService.getApplicationLocation(app.name);
      }

      if (appLocations.length > 0) {
        const appIps = [];

        // if its G data application, use just one IP
        const locationIps = appLocations.map((location) => location.ip);
        // eslint-disable-next-line no-await-in-loop
        const selectedIP = await selectIPforG(locationIps, app);
        if (selectedIP) {
          appIps.push(selectedIP);
          addConfigurations(configuredApps, app, appIps, true);
          log.info(
            `G Application ${app.name} is OK selected IP is ${selectedIP}. Proceeding to FDM`,
          );
        }

        if (config.mandatoryApps.includes(app.name) && appIps.length < 1) {
          throw new Error(`Application ${app.name} checks not ok. PANIC.`);
        }
      } else {
        log.warn(
          `G Application ${app.name} is excluded. Not running properly?`,
        );
        if (config.mandatoryApps.includes(app.name)) {
          throw new Error(`Application ${app.name} is not running well PANIC.`);
        }
      }
    }

    if (
      JSON.stringify(configuredApps) === JSON.stringify(recentlyConfiguredGApps)
    ) {
      log.info('No changes in G Mode configuration detected');
    } else {
      log.info('Changes in G Mode configuration detected');
    }
    let haproxyAppsConfig = [];

    recentlyConfiguredGApps = configuredApps;
    gAppsProcessingFinishedOnce = true;
    if (nonGAppsProcessingFinishedOnce) {
      haproxyAppsConfig = recentlyConfiguredApps.concat(configuredApps);
    }

    if (
      nonGAppsProcessingFinishedOnce
      && gAppsProcessingFinishedOnce
      && JSON.stringify(lastHaproxyAppsConfig)
        !== JSON.stringify(haproxyAppsConfig)
    ) {
      log.info(
        `G Mode updating haproxy with lenght: ${haproxyAppsConfig.length}`,
      );
      lastHaproxyAppsConfig = haproxyAppsConfig;
      await updateHaproxy(haproxyAppsConfig);
    }
  } catch (error) {
    log.error(error);
  } finally {
    log.info(`G Mode ENDED at${new Date()}`);
  }
}

async function obtainCertificatesMode() {
  try {
    // get applications on the network
    let applicationSpecifications = await fluxService.getAppSpecifications();

    // filter applications based on config
    applicationSpecifications = getApplicationsToProcess(
      applicationSpecifications,
    );
    for (const appSpecs of applicationSpecifications) {
      const customDomains = getCustomDomains(appSpecs);
      if (customDomains.length) {
        log.info(`Processing ${appSpecs.name}`);
        // eslint-disable-next-line no-await-in-loop
        const customCertOperationsSuccessful = await executeCertificateOperations(
          customDomains,
          DOMAIN_TYPE.CUSTOM,
          myFDMnameORip,
          myIP,
        );
        if (customCertOperationsSuccessful) {
          log.info(
            `Application domain and ssl for custom domains of ${appSpecs.name} is ready`,
          );
        } else {
          log.error(`Domain/ssl issues for custom domains of ${appSpecs.name}`);
        }
      }
    }
    log.info('Certificates obtained');
    setTimeout(() => {
      obtainCertificatesMode();
      startCertRsync();
    }, 5 * 60 * 1000);
  } catch (error) {
    log.error(error);
    setTimeout(() => {
      obtainCertificatesMode();
      startCertRsync();
    }, 5 * 60 * 1000);
  }
}

// services run every 6 mins
function initializeServices() {
  myIP = ipService.localIP();
  console.log(myIP);
  if (config.domainAppType === 'CNAME') {
    myFDMnameORip = config.fdmAppDomain;
  } else {
    myFDMnameORip = myIP;
  }
  if (myIP) {
    if (config.manageCertificateOnly) {
      obtainCertificatesMode();
      startCertRsync();
      log.info('FDM Certificate Service initialized.');
    } else if (
      config.mainDomain === config.cloudflare.domain
      && !config.cloudflare.manageapp
    ) {
      generateAndReplaceMainHaproxyConfig();
      log.info('Flux Main Node Domain Service initiated.');
    } else if (
      config.mainDomain === config.pDNS.domain
      && !config.pDNS.manageapp
    ) {
      generateAndReplaceMainHaproxyConfig();
      log.info('Flux Main Node Domain Service initiated.');
    } else if (
      config.mainDomain === config.cloudflare.domain
      && config.cloudflare.manageapp
    ) {
      // only runs on main FDM handles X.APP.runonflux.io
      generateAndReplaceMainApplicationHaproxyConfig();
      setTimeout(() => {
        generateAndReplaceMainApplicationHaproxyGAppsConfig();
      }, 60 * 1000);
      log.info('Flux Main Application Domain Service initiated.');
    } else if (
      config.mainDomain === config.pDNS.domain
      && config.pDNS.manageapp
    ) {
      // only runs on main FDM handles X.APP.runonflux.io
      generateAndReplaceMainApplicationHaproxyConfig();
      setTimeout(() => {
        generateAndReplaceMainApplicationHaproxyGAppsConfig();
      }, 60 * 1000);
      log.info('Flux Main Application Domain Service initiated.');
    } else {
      log.info('CUSTOM DOMAIN SERVICE UNAVAILABLE');
    }
  } else {
    log.warn('Awaiting FDM IP address...');
    setTimeout(() => {
      initializeServices();
    }, 5 * 1000);
  }
}

async function start() {
  if (!dataFetcher) {
    // symlink these to the same place on every fdm
    // these paths are just dev at the moment
    dataFetcher = new FdmDataFetcher({
      keyPath: '/root/fdm-arcane-specs/fdm-eu-2-1.key',
      certPath: '/root/fdm-arcane-specs/fdm-eu-2-1.pem',
      caPath: '/root/fdm-arcane-specs/ca.pem',
      fluxApiBaseUrl: 'https://api.runonflux.io/',
      sasApiBaseUrl: 'https://10.100.0.170/api/',
    });

    dataFetcher.on(
      'appSpecsUpdated',
      async (specs) => {
        unifiedAppsDomains = specs.appFqdns;
        await generateAndReplaceMainApplicationHaproxyConfig(specs.nonGApps);
        await generateAndReplaceMainApplicationHaproxyGAppsConfig(specs.gApps);
      },
    );
    dataFetcher.on('permMessagesUpdated', (permMessages) => {
      permanentMessages = permMessages;
    });

    dataFetcher.startAppSpecLoop();
    dataFetcher.startPermMessagesLoop();
  }

  try {
    log.info('Initiating FDM API services...');
    initializeServices();
  } catch (e) {
    // restart service after 5 mins
    log.error(e);
    setTimeout(() => {
      start();
    }, 5 * 60 * 1000);
  }
}

module.exports = {
  start,
};

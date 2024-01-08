/* eslint-disable no-restricted-syntax */
const config = require('config');
const fs = require('fs').promises;
const log = require('../lib/log');
const ipService = require('./ipService');
const fluxService = require('./flux');
const haproxyTemplate = require('./haproxyTemplate');
const { processApplications, getUnifiedDomains, getCustomDomains } = require('./domain');
const { executeCertificateOperations } = require('./domain/cert');
const applicationChecks = require('./application/checks');
const { getCustomConfigs } = require('./application/custom');
const { getApplicationsToProcess } = require('./application/subset');
const { DOMAIN_TYPE } = require('./constants');
const { startCertRsync } = require('./rsync');

let myIP = null;
let myFDMnameORip = null;
let permanentMessages = null;
let globalAppSpecs = null;
const unifiedAppsDomains = [];
const mapOfNamesIps = {};
let recentlyConfiguredApps;

async function getPermanentMessages() {
  try {
    const messages = await fluxService.getFluxPermanentMessages();
    if (messages.length) {
      permanentMessages = messages;
    }
  } catch (error) {
    log.error(error);
  }
}

async function getGlobalAppSpecs() {
  try {
    const specs = await fluxService.getAppSpecifications();
    if (specs.length) {
      globalAppSpecs = specs;
      specs.forEach((app) => {
        if (app.version <= 3) {
          for (let i = 0; i < app.ports.length; i += 1) {
            if (app.domains[i]) {
              const portDomains = app.domains[i].split(',');
              const domains = [];
              for (let portDomain of portDomains) {
                portDomain = portDomain.replace('https://', '').replace('http://', '').replace(/[&/\\#,+()$~%'":*?<>{}]/g, '').toLowerCase(); // . is allowed
                domains.push(portDomain);
              }
              unifiedAppsDomains.push({ name: app.name, domains });
            }
          }
        } else {
          for (const component of app.compose) {
            const domains = [];
            for (let i = 0; i < component.ports.length; i += 1) {
              const portDomains = component.domains[i].split(',');
              // eslint-disable-next-line no-loop-func
              for (let portDomain of portDomains) {
                // eslint-disable-next-line no-param-reassign
                portDomain = portDomain.replace('https://', '').replace('http://', '').replace(/[&/\\#,+()$~%'":*?<>{}]/g, '').toLowerCase(); // . is allowed
                domains.push(portDomain);
              }
            }
            unifiedAppsDomains.push({ name: app.name, domains });
          }
        }
      });
    }
  } catch (error) {
    log.error(error);
  }
}

async function checkDomainOwnership(domain, appName) {
  try {
    if (!domain) {
      return true;
    }
    const filteredDomains = unifiedAppsDomains.filter((entry) => entry.domains.includes(domain.toLowerCase()));
    const ourAppExists = filteredDomains.find((existing) => existing.name === appName);
    if (filteredDomains.length >= 2 && ourAppExists) {
      // we have multiple apps that has the same domain assigned;
      // check permanent messages for these apps
      const appNames = [];
      filteredDomains.forEach((x) => {
        appNames.push(x.name);
      });
      const filteredPermanentMessages = permanentMessages.filter((mes) => appNames.includes(mes.appSpecifications.name)); // now we have only the messages that touch the apps that have the domain
      const adjustedFilteredPermMessages = [];
      filteredPermanentMessages.forEach((message) => {
        const stringedMessage = JSON.stringify(message).toLowerCase();
        if (stringedMessage.includes(domain.toLowerCase())) {
          adjustedFilteredPermMessages.push(message);
        }
      });
      const sortedPermanentFilteredMessages = adjustedFilteredPermMessages.sort((a, b) => {
        if (a.height < b.height) return -1;
        if (a.height > b.height) return 1;
        return 0;
      });
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
async function generateAndReplaceMainHaproxyConfig() {
  try {
    const ui = `home.${config.mainDomain}`;
    const api = `api.${config.mainDomain}`;
    const fluxIPs = await fluxService.getFluxIPs('STRATUS'); // use only stratus for home
    if (fluxIPs.length < 1000) {
      throw new Error('Invalid Flux List');
    }
    const fluxIPsForBalancing = [];
    // we want to do some checks on UI and API to verify functionality
    // 1st check is loginphrase
    // 2nd check is communication
    // 3rd is ui
    for (const ip of fluxIPs) {
      if (ip.split(':')[1] === 16127 || ip.split(':')[1] === '16127' || !ip.split(':')[1]) {
        // eslint-disable-next-line no-await-in-loop
        const isOK = await applicationChecks.checkMainFlux(ip.split(':')[0], ip.split(':')[1]); // can be undefined
        if (isOK) {
          fluxIPsForBalancing.push(ip);
          console.log(`adding ${ip} as backend`);
        }
      }
      if (fluxIPsForBalancing.length > 100) { // maximum of 100 for load balancing
        break;
      }
    }
    if (fluxIPsForBalancing.length < 10) {
      throw new Error('Not enough ok nodes, probably error');
    }
    const hc = await haproxyTemplate.createMainHaproxyConfig(ui, api, fluxIPsForBalancing);
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
    let chosenIpSum = ips[0].split(':')[0].split('.').reduce((a, b) => parseInt(a, 10) + parseInt(b, 10), 0);
    for (const ip of ips) {
      const sum = ip.split(':')[0].split('.').reduce((a, b) => parseInt(a, 10) + parseInt(b, 10), 0);
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
    const isOk = await applicationChecks.checkApplication(app, chosenIp);
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

// periodically keeps HAproxy ans certificates updated every 4 minutes
async function generateAndReplaceMainApplicationHaproxyConfig(isGmode = false) {
  try {
    if (isGmode) {
      if (!recentlyConfiguredApps) {
        throw new Error('G Mode is awaiting processing');
      }
    }
    // get permanent messages on the network
    await getPermanentMessages();
    // get applications on the network
    await getGlobalAppSpecs();

    if (!permanentMessages || !globalAppSpecs) {
      throw new Error('Obtained specifications invalid');
    }

    // filter applications based on config
    let applicationSpecifications = getApplicationsToProcess(globalAppSpecs);
    if (isGmode) {
      const gApps = [];
      // in G mode we process only apps that do have g: in containerData
      for (const app of applicationSpecifications) {
        if (app.version <= 3) {
          if (app.containerData.includes('g:')) {
            gApps.push(app);
          }
        } else {
          let isG = false;
          for (const component of app.compose) {
            if (component.containerData.includes('g:')) {
              isG = true;
            }
          }
          if (isG) {
            gApps.push(app);
          }
        }
      }
      applicationSpecifications = gApps;
    }

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
    const appsOK = await processApplications(applicationSpecifications, myFDMnameORip, myIP);
    // check appsOK against mandatoryApps
    let { mandatoryApps } = config;
    if (config.useSubset) {
      mandatoryApps = filterMandatoryApps(mandatoryApps);
    }
    if (!isGmode) {
      for (const mandatoryApp of mandatoryApps) {
        const appExists = appsOK.find((app) => app.name === mandatoryApp);
        if (!appExists) {
          throw new Error(`Mandatory app ${mandatoryApp} does not exist. PANIC`);
        }
      }
    }
    // continue with appsOK
    let configuredApps = []; // object of domain, port, ips for backend and isRdata
    for (const app of appsOK) {
      log.info(`Configuring ${app.name}`);
      // eslint-disable-next-line no-await-in-loop
      const appLocations = await fluxService.getApplicationLocation(app.name);
      if (app.name === 'blockbookbitcoin') {
        appLocations.push({ ip: '66.70.144.171' });
        appLocations.push({ ip: '66.70.144.172' });
      }
      if (app.name === 'blockbooklitecoin') {
        appLocations.push({ ip: '66.70.144.173' });
        appLocations.push({ ip: '66.70.144.174' });
      }
      if (app.name === 'blockbookdogecoin') {
        appLocations.push({ ip: '66.70.144.186' });
        appLocations.push({ ip: '66.70.144.187' });
      }
      if (app.name === 'blockbookravencoin') {
        appLocations.push({ ip: '54.39.237.202' });
        appLocations.push({ ip: '54.39.237.203' });
      }
      if (app.name === 'blockbookbitcointestnet') {
        appLocations.push({ ip: '54.39.237.198' });
        appLocations.push({ ip: '54.39.237.199' });
      }
      if (appLocations.length > 0) {
        const appIps = [];
        let isG = false;
        if (app.version <= 3) {
          if (app.containerData.includes('g:')) {
            isG = true;
          }
        } else {
          for (const component of app.compose) {
            if (component.containerData.includes('g:')) {
              isG = true;
            }
          }
        }
        // if its G data application, use just one IP
        if (isG) {
          const locationIps = [];
          for (const location of appLocations) {
            locationIps.push(location.ip);
          }
          // eslint-disable-next-line no-await-in-loop
          const selectedIP = await selectIPforG(locationIps, app);
          if (selectedIP) {
            appIps.push(selectedIP);
          }
        } else {
          for (const location of appLocations) { // run coded checks for app
            // eslint-disable-next-line no-await-in-loop
            const isOk = await applicationChecks.checkApplication(app, location.ip);
            if (isOk) {
              appIps.push(location.ip);
            }
          }
        }
        if (config.mandatoryApps.includes(app.name) && appIps.length < 1) {
          throw new Error(`Application ${app.name} checks not ok. PANIC.`);
        }
        const domains = getUnifiedDomains(app);
        const customConfigs = getCustomConfigs(app);
        if (app.version <= 3) {
          for (let i = 0; i < app.ports.length; i += 1) {
            const configuredApp = {
              name: app.name,
              appName: `${app.name}_${app.ports[i]}`,
              domain: domains[i],
              port: app.ports[i],
              ips: appIps,
              ...customConfigs[i],
            };
            if (app.containerData.includes('r:')) {
              configuredApp.isRdata = true;
            }
            configuredApps.push(configuredApp);
            if (app.domains[i]) {
              const portDomains = app.domains[i].split(',');
              for (let portDomain of portDomains) {
                // eslint-disable-next-line no-param-reassign
                portDomain = portDomain.replace('https://', '').replace('http://', '').replace(/[&/\\#,+()$~%'":*?<>{}]/g, ''); // . is allowed
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
                const domainAssigned = configuredApps.find((appThatIsConfigured) => appThatIsConfigured.domain === portDomain);
                if (portDomain && portDomain.includes('.') && portDomain.length > 3 && !portDomain.toLowerCase().includes(`${config.appSubDomain}.${config.mainDomain.split('.')[0]}`) && !domainAssigned) { // prevent double backend
                  const domainExists = configuredApps.find((a) => a.domain === portDomain.toLowerCase());
                  if (!domainExists) {
                    const configuredAppCustom = {
                      name: app.name,
                      appName: `${app.name}_${app.ports[i]}`,
                      domain: portDomain,
                      port: app.ports[i],
                      ips: appIps,
                      ...customConfigs[i],
                    };
                    if (app.containerData.includes('r:')) {
                      configuredAppCustom.isRdata = true;
                    }
                    configuredApps.push(configuredAppCustom);
                  }
                  const wwwAdjustedDomain = `www.${portDomain.toLowerCase()}`;
                  if (wwwAdjustedDomain) {
                    const domainExistsB = configuredApps.find((a) => a.domain === wwwAdjustedDomain);
                    if (!domainExistsB) {
                      const configuredAppCustom = {
                        name: app.name,
                        appName: `${app.name}_${app.ports[i]}`,
                        domain: wwwAdjustedDomain,
                        port: app.ports[i],
                        ips: appIps,
                        ...customConfigs[i],
                      };
                      if (app.containerData.includes('r:')) {
                        configuredAppCustom.isRdata = true;
                      }
                      configuredApps.push(configuredAppCustom);
                    }
                  }

                  const testAdjustedDomain = `test.${portDomain.toLowerCase()}`;
                  if (testAdjustedDomain) {
                    const domainExistsB = configuredApps.find((a) => a.domain === testAdjustedDomain);
                    if (!domainExistsB) {
                      const configuredAppCustom = {
                        name: app.name,
                        appName: `${app.name}_${app.ports[i]}`,
                        domain: testAdjustedDomain,
                        port: app.ports[i],
                        ips: appIps,
                        ...customConfigs[i],
                      };
                      if (app.containerData.includes('r:')) {
                        configuredAppCustom.isRdata = true;
                      }
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
            ...customConfigs[customConfigs.length - 1],
          };
          if (app.containerData.includes('r:')) {
            mainApp.isRdata = true;
          }
          configuredApps.push(mainApp);
        } else {
          let j = 0;
          for (const component of app.compose) {
            for (let i = 0; i < component.ports.length; i += 1) {
              const configuredApp = {
                name: app.name,
                appName: `${app.name}_${component.name}_${component.ports[i]}`,
                domain: domains[j],
                port: component.ports[i],
                ips: appIps,
                ...customConfigs[j],
              };
              if (component.containerData.includes('r:')) {
                configuredApp.isRdata = true;
              }
              configuredApps.push(configuredApp);
              const portDomains = component.domains[i].split(',');
              // eslint-disable-next-line no-loop-func
              for (let portDomain of portDomains) {
                // eslint-disable-next-line no-param-reassign
                portDomain = portDomain.replace('https://', '').replace('http://', '').replace(/[&/\\#,+()$~%'":*?<>{}]/g, ''); // . is allowed
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
                const domainAssigned = configuredApps.find((appThatIsConfigured) => appThatIsConfigured.domain === portDomain);
                if (portDomain && portDomain.includes('.') && portDomain.length >= 3 && !portDomain.toLowerCase().includes(`${config.appSubDomain}.${config.mainDomain.split('.')[0]}`) && !domainAssigned) {
                  if (!portDomain.includes(`${config.appSubDomain}${config.mainDomain.split('.')[0]}`)) { // prevent double backend
                    const domainExists = configuredApps.find((a) => a.domain === portDomain.toLowerCase());
                    if (!domainExists) {
                      const configuredAppCustom = {
                        name: app.name,
                        appName: `${app.name}_${component.name}_${component.ports[i]}`,
                        domain: portDomain,
                        port: component.ports[i],
                        ips: appIps,
                        ...customConfigs[j],
                      };
                      if (component.containerData.includes('r:')) {
                        configuredAppCustom.isRdata = true;
                      }
                      configuredApps.push(configuredAppCustom);
                    }

                    const wwwAdjustedDomain = `www.${portDomain.toLowerCase()}`;
                    if (wwwAdjustedDomain) {
                      const domainExistsB = configuredApps.find((a) => a.domain === wwwAdjustedDomain);
                      if (!domainExistsB) {
                        const configuredAppCustom = {
                          name: app.name,
                          appName: `${app.name}_${component.name}_${component.ports[i]}`,
                          domain: wwwAdjustedDomain,
                          port: component.ports[i],
                          ips: appIps,
                          ...customConfigs[j],
                        };
                        if (component.containerData.includes('r:')) {
                          configuredAppCustom.isRdata = true;
                        }
                        configuredApps.push(configuredAppCustom);
                      }
                    }

                    const testAdjustedDomain = `test.${portDomain.toLowerCase()}`;
                    if (testAdjustedDomain) {
                      const domainExistsB = configuredApps.find((a) => a.domain === testAdjustedDomain);
                      if (!domainExistsB) {
                        const configuredAppCustom = {
                          name: app.name,
                          appName: `${app.name}_${component.name}_${component.ports[i]}`,
                          domain: testAdjustedDomain,
                          port: component.ports[i],
                          ips: appIps,
                          ...customConfigs[j],
                        };
                        if (component.containerData.includes('r:')) {
                          configuredAppCustom.isRdata = true;
                        }
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
              const mainDomainExists = configuredApps.find((qw) => qw.domain === domains[domains.length - 1]);
              if (!mainDomainExists) {
                const mainApp = {
                  name: app.name,
                  appName: `${app.name}_${app.compose[q].name}_${app.compose[q].ports[w]}`,
                  domain: domains[domains.length - 1],
                  port: app.compose[q].ports[w],
                  ips: appIps,
                  ...customConfigs[customConfigs.length - 1],
                };
                if (app.compose[q].containerData.includes('r:')) {
                  mainApp.isRdata = true;
                }
                configuredApps.push(mainApp);
              }
            }
          }
        }
        log.info(`Application ${app.name} is OK. Proceeding to FDM`);
      } else {
        log.warn(`Application ${app.name} is excluded. Not running properly?`);
        if (config.mandatoryApps.includes(app.name)) {
          throw new Error(`Application ${app.name} is not running well PANIC.`);
        }
      }
    }

    if (isGmode) {
      const updatingConfig = JSON.parse(JSON.stringify(recentlyConfiguredApps));
      // merge recentlyConfiguredApps with currently configuredApps
      for (const app of updatingConfig) {
        let appExists = recentlyConfiguredApps.find((a) => a.appName === app.appName);
        if (!appExists) {
          updatingConfig.push(app);
        } else {
          appExists = app; // this is also updating element in updatingConfig
        }
      }
      configuredApps = updatingConfig;
    }

    if (configuredApps.length < 10) {
      throw new Error('PANIC PLEASE DEV HELP ME');
    }
    if (JSON.stringify(configuredApps) === JSON.stringify(recentlyConfiguredApps)) {
      log.info('No changes in configuration detected');
    } else if (isGmode) {
      log.info('Changes in configuration detected in G mode');
    } else {
      log.info('Changes in configuration detected');
    }
    recentlyConfiguredApps = configuredApps;
    const hc = await haproxyTemplate.createAppsHaproxyConfig(configuredApps);
    console.log(hc);
    const dataToWrite = hc;
    // test haproxy config
    const successRestart = await haproxyTemplate.restartProxy(dataToWrite);
    if (!successRestart) {
      throw new Error('Invalid HAPROXY Config File!');
    }
    setTimeout(() => {
      generateAndReplaceMainApplicationHaproxyConfig(isGmode);
    }, 30 * 1000);
  } catch (error) {
    log.error(error);
    setTimeout(() => {
      generateAndReplaceMainApplicationHaproxyConfig(isGmode);
    }, 30 * 1000);
  }
}

async function obtainCertificatesMode() {
  try {
    // get applications on the network
    let applicationSpecifications = await fluxService.getAppSpecifications();

    // filter applications based on config
    applicationSpecifications = getApplicationsToProcess(applicationSpecifications);
    for (const appSpecs of applicationSpecifications) {
      const customDomains = getCustomDomains(appSpecs);
      if (customDomains.length) {
        log.info(`Processing ${appSpecs.name}`);
        // eslint-disable-next-line no-await-in-loop
        const customCertOperationsSuccessful = await executeCertificateOperations(customDomains, DOMAIN_TYPE.CUSTOM, myFDMnameORip, myIP);
        if (customCertOperationsSuccessful) {
          log.info(`Application domain and ssl for custom domains of ${appSpecs.name} is ready`);
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
    } else if (config.mainDomain === config.cloudflare.domain && !config.cloudflare.manageapp) {
      generateAndReplaceMainHaproxyConfig();
      log.info('Flux Main Node Domain Service initiated.');
    } else if (config.mainDomain === config.pDNS.domain && !config.pDNS.manageapp) {
      generateAndReplaceMainHaproxyConfig();
      log.info('Flux Main Node Domain Service initiated.');
    } else if (config.mainDomain === config.cloudflare.domain && config.cloudflare.manageapp) {
      // only runs on main FDM handles X.APP.runonflux.io
      generateAndReplaceMainApplicationHaproxyConfig();
      setTimeout(() => {
        generateAndReplaceMainApplicationHaproxyConfig(true);
      }, 5 * 60 * 1000);
      log.info('Flux Main Application Domain Service initiated.');
    } else if (config.mainDomain === config.pDNS.domain && config.pDNS.manageapp) {
      // only runs on main FDM handles X.APP.runonflux.io
      generateAndReplaceMainApplicationHaproxyConfig();
      setTimeout(() => {
        generateAndReplaceMainApplicationHaproxyConfig(true);
      }, 5 * 60 * 1000);
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

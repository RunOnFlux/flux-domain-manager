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

let myIP = null;
let myFDMnameORip = null;

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
    }, 4 * 60 * 1000);
  } catch (error) {
    log.error(error);
    setTimeout(() => {
      generateAndReplaceMainHaproxyConfig();
    }, 4 * 60 * 1000);
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

// periodically keeps HAproxy ans certificates updated every 4 minutes
async function generateAndReplaceMainApplicationHaproxyConfig() {
  try {
    // get applications on the network
    let applicationSpecifications = await fluxService.getAppSpecifications();

    // filter applications based on config
    applicationSpecifications = getApplicationsToProcess(applicationSpecifications);

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
    for (const mandatoryApp of mandatoryApps) {
      const appExists = appsOK.find((app) => app.name === mandatoryApp);
      if (!appExists) {
        throw new Error(`Mandatory app ${mandatoryApp} does not exist. PANIC`);
      }
    }
    // continue with appsOK
    const configuredApps = []; // object of domain, port, ips for backend
    const paralelism = 4; // process 4 apps at the same time
    const appsToProcessBatches = []; // [[.,.,.,.,],[.,.,.,.,],[.,.,.]];
    let appsToProcessBatchX = [];
    for (let i = 0; i < appsOK.length; i += 1) {
      appsToProcessBatchX.push(appsOK[i]);
      if (appsToProcessBatchX.length >= paralelism) { // if batch contains more or equal to, finalise this batch
        appsToProcessBatches.push(appsToProcessBatchX);
        appsToProcessBatchX = [];
      }
    }
    if (appsToProcessBatchX.length) {
      appsToProcessBatches.push(appsToProcessBatchX); // last batch can have less apps
    }
    for (const appBatch of appsToProcessBatches) {
      const locationPromises = [];
      for (let i = 0; i < appBatch.length; i += 1) {
        locationPromises.push(fluxService.getApplicationLocation(appBatch[i].name));
      }
      // eslint-disable-next-line no-await-in-loop
      const locationResults = (await Promise.allSettled(locationPromises)).map((res) => res.value);
      for (const [index, app] of appBatch.entries()) {
        log.info(`Configuring ${app.name}`);
        const appLocations = locationResults[index];
        if (appLocations.length) {
          const appIps = [];
          // batch processing
          const checkParalelism = 10;
          const appCheckPromisesBatches = []; // [[.,.,.,.,],[.,.,.,.,],[.,.,.]];
          let appCheckPromisesBatchX = [];
          for (let i = 0; i < appLocations.length; i += 1) {
            appCheckPromisesBatchX.push(appLocations[i]);
            if (appCheckPromisesBatchX.length >= checkParalelism) { // if batch contains more or equal to, finalise this batch
              appCheckPromisesBatches.push(appCheckPromisesBatchX);
              appCheckPromisesBatchX = [];
            }
          }
          if (appCheckPromisesBatchX.length) {
            appCheckPromisesBatches.push(appCheckPromisesBatchX); // last batch can have less apps
          }
          for (const appChecPromiseBatch of appCheckPromisesBatches) {
            const checkPromises = [];
            for (let i = 0; i < appChecPromiseBatch.length; i += 1) {
              checkPromises.push(applicationChecks.checkApplication(app, appChecPromiseBatch[i].ip));
            }
            // eslint-disable-next-line no-await-in-loop
            const appChecksResults = (await Promise.allSettled(checkPromises)).map((res) => res.value); // shall we split it, if an app has a lot of instances?
            for (let i = 0; i < appChecksResults.length; i += 1) {
              if (appChecksResults[i]) {
                appIps.push(appChecPromiseBatch[i].ip);
              }
            }
          }
          if (config.mandatoryApps.includes(app.name) && appIps.length < 1) {
            throw new Error(`Application ${app.name} checks not ok. PANIC.`);
          } else if (!appIps.length) {
            log.warn(`Application ${app.name} is excluded. App checks not ok`);
          } else {
            const domains = getUnifiedDomains(app);
            const customConfigs = getCustomConfigs(app);
            if (app.version <= 3) {
              for (let i = 0; i < app.ports.length; i += 1) {
                const configuredApp = {
                  appName: `${app.name}_${app.ports[i]}`,
                  domain: domains[i],
                  port: app.ports[i],
                  ips: appIps,
                  ...customConfigs[i],
                };
                configuredApps.push(configuredApp);
                if (app.domains[i]) {
                  const portDomains = app.domains[i].split(',');
                  portDomains.forEach((portDomain) => {
                  // prevention for double backend on custom domains, can be improved
                    const domainAssigned = configuredApps.find((appThatIsConfigured) => appThatIsConfigured.domain === portDomain);
                    if (portDomain && portDomain.includes('.') && portDomain.length > 3 && !portDomain.toLowerCase().includes(`${config.appSubDomain}.${config.mainDomain.split('.')[0]}`) && !domainAssigned) { // prevent double backend
                      const domainExists = configuredApps.find((a) => a.domain === portDomain.toLowerCase());
                      if (!domainExists) {
                        const configuredAppCustom = {
                          appName: `${app.name}_${app.ports[i]}`,
                          domain: portDomain.toLowerCase().replace('https://', '').replace('http://', '').replace(/[&/\\#,+()$~%'":*?<>{}]/g, ''), // . is allowed
                          port: app.ports[i],
                          ips: appIps,
                          ...customConfigs[i],
                        };
                        configuredApps.push(configuredAppCustom);
                      }
                      const wwwAdjustedDomain = portDomain.includes('www.') ? portDomain.toLowerCase().split('www.')[1] : `www.${portDomain.toLowerCase()}`;
                      if (wwwAdjustedDomain) {
                        const domainExistsB = configuredApps.find((a) => a.domain === wwwAdjustedDomain);
                        if (!domainExistsB) {
                          const configuredAppCustom = {
                            appName: `${app.name}_${app.ports[i]}`,
                            domain: wwwAdjustedDomain.replace('https://', '').replace('http://', '').replace(/[&/\\#,+()$~%'":*?<>{}]/g, ''), // . is allowed
                            port: app.ports[i],
                            ips: appIps,
                            ...customConfigs[i],
                          };
                          configuredApps.push(configuredAppCustom);
                        }
                      }

                      const testAdjustedDomain = portDomain.includes('test.') ? portDomain.toLowerCase().split('test.')[1] : `test.${portDomain.toLowerCase()}`;
                      if (testAdjustedDomain) {
                        const domainExistsB = configuredApps.find((a) => a.domain === testAdjustedDomain);
                        if (!domainExistsB) {
                          const configuredAppCustom = {
                            appName: `${app.name}_${app.ports[i]}`,
                            domain: testAdjustedDomain.replace('https://', '').replace('http://', '').replace(/[&/\\#,+()$~%'":*?<>{}]/g, ''), // . is allowed
                            port: app.ports[i],
                            ips: appIps,
                            ...customConfigs[i],
                          };
                          configuredApps.push(configuredAppCustom);
                        }
                      }
                    }
                  });
                }
              }
              const mainApp = {
                appName: `${app.name}_${app.ports[0]}`,
                domain: domains[domains.length - 1],
                port: app.ports[0],
                ips: appIps,
                ...customConfigs[customConfigs.length - 1],
              };
              configuredApps.push(mainApp);
            } else {
              let j = 0;
              for (const component of app.compose) {
                for (let i = 0; i < component.ports.length; i += 1) {
                  const configuredApp = {
                    appName: `${app.name}_${component.name}_${component.ports[i]}`,
                    domain: domains[j],
                    port: component.ports[i],
                    ips: appIps,
                    ...customConfigs[j],
                  };
                  configuredApps.push(configuredApp);
                  const portDomains = component.domains[i].split(',');
                  // eslint-disable-next-line no-loop-func
                  portDomains.forEach((portDomain) => {
                  // prevention for double backend on custom domains, can be improved
                    const domainAssigned = configuredApps.find((appThatIsConfigured) => appThatIsConfigured.domain === portDomain);
                    if (portDomain && portDomain.includes('.') && portDomain.length >= 3 && !portDomain.toLowerCase().includes(`${config.appSubDomain}.${config.mainDomain.split('.')[0]}`) && !domainAssigned) {
                      if (!portDomain.includes(`${config.appSubDomain}${config.mainDomain.split('.')[0]}`)) { // prevent double backend
                        const domainExists = configuredApps.find((a) => a.domain === portDomain.toLowerCase());
                        if (!domainExists) {
                          const configuredAppCustom = {
                            appName: `${app.name}_${component.name}_${component.ports[i]}`,
                            domain: portDomain.toLowerCase().replace('https://', '').replace('http://', '').replace(/[&/\\#,+()$~%'":*?<>{}]/g, ''), // . is allowed
                            port: component.ports[i],
                            ips: appIps,
                            ...customConfigs[j],
                          };
                          configuredApps.push(configuredAppCustom);
                        }

                        const wwwAdjustedDomain = portDomain.includes('www.') ? portDomain.toLowerCase().split('www.')[1] : `www.${portDomain.toLowerCase()}`;
                        if (wwwAdjustedDomain) {
                          const domainExistsB = configuredApps.find((a) => a.domain === wwwAdjustedDomain);
                          if (!domainExistsB) {
                            const configuredAppCustom = {
                              appName: `${app.name}_${component.name}_${component.ports[i]}`,
                              domain: wwwAdjustedDomain.replace('https://', '').replace('http://', '').replace(/[&/\\#,+()$~%'":*?<>{}]/g, ''), // . is allowed
                              port: component.ports[i],
                              ips: appIps,
                              ...customConfigs[j],
                            };
                            configuredApps.push(configuredAppCustom);
                          }
                        }

                        const testAdjustedDomain = portDomain.includes('test.') ? portDomain.toLowerCase().split('test.')[1] : `test.${portDomain.toLowerCase()}`;
                        if (testAdjustedDomain) {
                          const domainExistsB = configuredApps.find((a) => a.domain === testAdjustedDomain);
                          if (!domainExistsB) {
                            const configuredAppCustom = {
                              appName: `${app.name}_${component.name}_${component.ports[i]}`,
                              domain: testAdjustedDomain.replace('https://', '').replace('http://', '').replace(/[&/\\#,+()$~%'":*?<>{}]/g, ''), // . is allowed
                              port: component.ports[i],
                              ips: appIps,
                              ...customConfigs[j],
                            };
                            configuredApps.push(configuredAppCustom);
                          }
                        }
                      }
                    }
                  });
                  j += 1;
                }
              }
              // push main domain
              for (let q = 0; q < app.compose.length; q += 1) {
                for (let w = 0; w < app.compose[q].ports.length; w += 1) {
                  const mainDomainExists = configuredApps.find((qw) => qw.domain === domains[domains.length - 1]);
                  if (!mainDomainExists) {
                    const mainApp = {
                      appName: `${app.name}_${app.compose[q].name}_${app.compose[q].ports[w]}`,
                      domain: domains[domains.length - 1],
                      port: app.compose[q].ports[w],
                      ips: appIps,
                      ...customConfigs[customConfigs.length - 1],
                    };
                    configuredApps.push(mainApp);
                  }
                }
              }
            }
            log.info(`Application ${app.name} is OK. Proceeding to FDM`);
          }
        } else {
          log.warn(`Application ${app.name} is excluded. Not running properly?`);
          if (config.mandatoryApps.includes(app.name)) {
            throw new Error(`Application ${app.name} is not running well PANIC.`);
          }
        }
      }
    }

    if (configuredApps.length < 10) {
      throw new Error('PANIC PLEASE DEV HELP ME');
    }

    const hc = await haproxyTemplate.createAppsHaproxyConfig(configuredApps);
    console.log(hc);
    const dataToWrite = hc;
    // test haproxy config
    const successRestart = await haproxyTemplate.restartProxy(dataToWrite);
    if (!successRestart) {
      throw new Error('Invalid HAPROXY Config File!');
    }
    setTimeout(() => {
      generateAndReplaceMainApplicationHaproxyConfig();
    }, 4 * 60 * 1000);
  } catch (error) {
    log.error(error);
    setTimeout(() => {
      generateAndReplaceMainApplicationHaproxyConfig();
    }, 4 * 60 * 1000);
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
    }, 5 * 60 * 1000);
  } catch (error) {
    log.error(error);
    setTimeout(() => {
      obtainCertificatesMode();
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
      log.info('Flux Main Application Domain Service initiated.');
    } else if (config.mainDomain === config.pDNS.domain && config.pDNS.manageapp) {
      // only runs on main FDM handles X.APP.runonflux.io
      generateAndReplaceMainApplicationHaproxyConfig();
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

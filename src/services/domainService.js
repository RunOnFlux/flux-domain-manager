/* eslint-disable no-restricted-syntax */
const config = require('config');
const fs = require('fs').promises;
const log = require('../lib/log');
const ipService = require('./ipService');
const fluxService = require('./flux');
const haproxyTemplate = require('./haproxyTemplate');
const applicationChecks = require('./applicationChecks');
const { processApplications, getUnifiedDomains } = require('./domain');
const { cmdAsync } = require('./constants');

let myIP = null;
let myFDMnameORip = null;

const mandatoryApps = ['explorer', 'KDLaunch', 'website', 'Kadena3', 'Kadena4'];

// Generates config file for HAProxy
async function generateAndReplaceMainHaproxyConfig() {
  try {
    const ui = `home.${config.mainDomain}`;
    const api = `api.${config.mainDomain}`;
    const fluxIPs = await fluxService.getFluxIPs();
    if (fluxIPs.length < 10) {
      throw new Error('Invalid Flux List');
    }
    const fluxIPsForBalancing = [];
    // we want to do some checks on UI and API to verify functionality
    // 1st check is loginphrase
    // 2nd check is communication
    // 3rd is ui
    for (const ip of fluxIPs) {
      // eslint-disable-next-line no-await-in-loop
      const isOK = await applicationChecks.checkMainFlux(ip.split(':')[0], ip.split(':')[1]); // can be undefined
      if (isOK) {
        fluxIPsForBalancing.push(ip);
        console.log(`adding ${ip} as backend`);
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
    const haproxyPathTemp = '/tmp/haproxytemp.cfg';
    await fs.writeFile(haproxyPathTemp, dataToWrite);
    const response = await cmdAsync(`sudo haproxy -f ${haproxyPathTemp} -c`);
    if (response.includes('Configuration file is valid')) {
      // write and reload
      const haproxyPath = '/etc/haproxy/haproxy.cfg';
      await fs.writeFile(haproxyPath, dataToWrite);
      const execHAreload = 'sudo service haproxy reload';
      await cmdAsync(execHAreload);
    } else {
      throw new Error('Invalid HAPROXY config file!');
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

function getCustomConfigs(specifications) {
  const configs = [];
  const defaultConfig = {
    ssl: false,
    timeout: false,
    headers: false,
    loadBalance: false,
    healthcheck: [],
    serverConfig: '',
    enableH2: false,
  };

  const customConfigs = {
    '31350.KadefiChainwebNode.KadefiMoneyBackend': {
      ssl: true,
      timeout: 90000,
    },
    '31350.KadefiPactAPI.KadefiMoneyPactAPI': {
      ssl: true,
      healthcheck: ['option httpchk', 'http-check send meth GET uri /health', 'http-check expect status 200'],
      serverConfig: 'port 31352 inter 30s fall 2 rise 2',
    },
    '31351.KadefiPactAPI.KadefiMoneyPactAPI': {
      timeout: 90000,
      loadBalance: '\n  balance roundrobin',
      healthcheck: ['option httpchk', 'http-check send meth GET uri /health', 'http-check expect status 200'],
      serverConfig: 'port 31352 inter 30s fall 2 rise 2',
    },
    '31352.KadenaChainWebData.Kadena3': {
      timeout: 90000,
      loadBalance: '\n  balance roundrobin',
    },
    '31352.KadefiPactAPI.KadefiMoneyPactAPI': {
      healthcheck: ['option httpchk', 'http-check send meth GET uri /health', 'http-check expect status 200'],
      serverConfig: 'inter 30s fall 2 rise 2',
    },
    '33952.wp.wordpressonflux': {
      headers: ['http-request add-header X-Forwarded-Proto https'],
    },
    '35000.KadefiMoneyDevAPI.KadefiMoneyDevAPI': {
      ssl: true,
      enableH2: true,
    },
  };

  let mainPort = '';
  if (specifications.version <= 3) {
    for (let i = 0; i < specifications.ports.length; i += 1) {
      const portName = `${specifications.ports[i]}.${specifications.name}`;
      if (i === 0) {
        mainPort = portName;
      }
      const appCustomConfig = customConfigs[portName] ? ({ ...defaultConfig, ...customConfigs[portName] }) : defaultConfig;
      configs.push(appCustomConfig);
    }
  } else {
    for (const component of specifications.compose) {
      for (let i = 0; i < component.ports.length; i += 1) {
        const portName = `${component.ports[i]}.${component.name}.${specifications.name}`;
        const appCustomConfig = customConfigs[portName] ? ({ ...defaultConfig, ...customConfigs[portName] }) : defaultConfig;
        configs.push(appCustomConfig);
      }
    }
  }
  const appCustomConfig = customConfigs[mainPort] ? ({ ...defaultConfig, ...customConfigs[mainPort] }) : defaultConfig;
  configs.push(appCustomConfig);
  return configs;
}

async function createSSLDirectory() {
  const dir = `/etc/ssl/${config.certFolder}`;
  await fs.mkdir(dir, { recursive: true });
}

// periodically keeps HAproxy ans certificates updated every 4 minutes
async function generateAndReplaceMainApplicationHaproxyConfig() {
  try {
    // get applications on the network
    const applicationSpecifications = await fluxService.getAppSpecifications();
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
    const appsOK = await processApplications(applicationSpecifications, myFDMnameORip);
    // check appsOK against mandatoryApps
    for (const mandatoryApp of mandatoryApps) {
      const appExists = appsOK.find((app) => app.name === mandatoryApp);
      if (!appExists) {
        throw new Error(`Mandatory app ${mandatoryApp} does not exist. PANIC`);
      }
    }
    // continue with appsOK
    const configuredApps = []; // object of domain, port, ips for backend
    for (const app of appsOK) {
      log.info(`Configuring ${app.name}`);
      const generalWebsiteApps = ['website', 'AtlasCloudMainnet', 'HavenVaultMainnet', 'KDLaunch', 'paoverview', 'FluxInfo', 'Jetpack2', 'jetpack', 'themok', 'themok2', 'themok3', 'themok4', 'themok5'];
      // eslint-disable-next-line no-await-in-loop
      const appLocations = await fluxService.getApplicationLocation(app.name);
      if (appLocations.length > 0) {
        const appIps = [];
        for (const location of appLocations) { // run coded checks for app
          if (generalWebsiteApps.includes(app.name)) {
            // <= 3 or compose of 1 component
            // eslint-disable-next-line no-await-in-loop
            const isOK = await applicationChecks.generalWebsiteCheck(location.ip.split(':')[0], app.port || app.ports ? app.ports[0] : app.compose[0].ports[0]);
            if (isOK) {
              appIps.push(location.ip);
            }
          } else if (app.name === 'EthereumNodeLight') {
            // eslint-disable-next-line no-await-in-loop
            const isOK = await applicationChecks.checkEthereum(location.ip.split(':')[0], 31301);
            if (isOK) {
              appIps.push(location.ip);
            }
          } else if (app.name === 'explorer') {
            // eslint-disable-next-line no-await-in-loop
            const isOK = await applicationChecks.checkFluxExplorer(location.ip.split(':')[0], 39185);
            if (isOK) {
              appIps.push(location.ip);
            }
          } else if (app.name === 'HavenNodeMainnet') {
            // eslint-disable-next-line no-await-in-loop
            const isOK = await applicationChecks.checkHavenHeight(location.ip.split(':')[0], 31750);
            if (isOK) {
              appIps.push(location.ip);
            }
          } else if (app.name === 'HavenNodeTestnet') {
            // eslint-disable-next-line no-await-in-loop
            const isOK = await applicationChecks.checkHavenHeight(location.ip.split(':')[0], 32750);
            if (isOK) {
              appIps.push(location.ip);
            }
          } else if (app.name === 'HavenNodeStagenet') {
            // eslint-disable-next-line no-await-in-loop
            const isOK = await applicationChecks.checkHavenHeight(location.ip.split(':')[0], 33750);
            if (isOK) {
              appIps.push(location.ip);
            }
          } else {
            appIps.push(location.ip);
          }
        }
        if (mandatoryApps.includes(app.name) && appIps.length < 1) {
          throw new Error(`Application ${app.name} checks not ok. PANIC.`);
        }
        const domains = getUnifiedDomains(app);
        const customConfigs = getCustomConfigs(app);
        if (app.version <= 3) {
          for (let i = 0; i < app.ports.length; i += 1) {
            const configuredApp = {
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
                      domain: portDomain.toLowerCase().replace('https://', '').replace('http://', '').replace(/[&/\\#,+()$~%'":*?<>{}]/g, ''), // . is allowed
                      port: app.ports[i],
                      ips: appIps,
                      ...customConfigs[i],
                    };
                    configuredApps.push(configuredAppCustom);
                  }
                  if (portDomain.includes('www.')) { // add domain without the www. prefix
                    const adjustedDomain = portDomain.toLowerCase().split('www.')[1];
                    if (adjustedDomain) {
                      const domainExistsB = configuredApps.find((a) => a.domain === adjustedDomain);
                      if (!domainExistsB) {
                        const configuredAppCustom = {
                          domain: adjustedDomain.replace('https://', '').replace('http://', '').replace(/[&/\\#,+()$~%'":*?<>{}]/g, ''), // . is allowed
                          port: app.ports[i],
                          ips: appIps,
                          ...customConfigs[i],
                        };
                        configuredApps.push(configuredAppCustom);
                      }
                    }
                  } else { // does not have www, add with www
                    const adjustedDomain = `www.${portDomain.toLowerCase()}`;
                    if (adjustedDomain) {
                      const domainExistsB = configuredApps.find((a) => a.domain === adjustedDomain);
                      if (!domainExistsB) {
                        const configuredAppCustom = {
                          domain: adjustedDomain.replace('https://', '').replace('http://', '').replace(/[&/\\#,+()$~%'":*?<>{}]/g, ''), // . is allowed
                          port: app.ports[i],
                          ips: appIps,
                          ...customConfigs[i],
                        };
                        configuredApps.push(configuredAppCustom);
                      }
                    }
                  }
                  if (portDomain.includes('test.')) { // add domain without the test. prefix
                    const adjustedDomain = portDomain.toLowerCase().split('test.')[1];
                    if (adjustedDomain) {
                      const domainExistsB = configuredApps.find((a) => a.domain === adjustedDomain);
                      if (!domainExistsB) {
                        const configuredAppCustom = {
                          domain: adjustedDomain.replace('https://', '').replace('http://', '').replace(/[&/\\#,+()$~%'":*?<>{}]/g, ''), // . is allowed
                          port: app.ports[i],
                          ips: appIps,
                          ...customConfigs[i],
                        };
                        configuredApps.push(configuredAppCustom);
                      }
                    }
                  } else { // does not have test, add with test
                    const adjustedDomain = `test.${portDomain.toLowerCase()}`;
                    if (adjustedDomain) {
                      const domainExistsB = configuredApps.find((a) => a.domain === adjustedDomain);
                      if (!domainExistsB) {
                        const configuredAppCustom = {
                          domain: adjustedDomain.replace('https://', '').replace('http://', '').replace(/[&/\\#,+()$~%'":*?<>{}]/g, ''), // . is allowed
                          port: app.ports[i],
                          ips: appIps,
                          ...customConfigs[i],
                        };
                        configuredApps.push(configuredAppCustom);
                      }
                    }
                  }
                }
              });
            }
          }
          const mainApp = {
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
                        domain: portDomain.toLowerCase().replace('https://', '').replace('http://', '').replace(/[&/\\#,+()$~%'":*?<>{}]/g, ''), // . is allowed
                        port: component.ports[i],
                        ips: appIps,
                        ...customConfigs[j],
                      };
                      configuredApps.push(configuredAppCustom);
                    }
                    if (portDomain.includes('www.')) { // add domain without the www. prefix
                      const adjustedDomain = portDomain.toLowerCase().split('www.')[1];
                      if (adjustedDomain) {
                        const domainExistsB = configuredApps.find((a) => a.domain === adjustedDomain);
                        if (!domainExistsB) {
                          const configuredAppCustom = {
                            domain: adjustedDomain.replace('https://', '').replace('http://', '').replace(/[&/\\#,+()$~%'":*?<>{}]/g, ''), // . is allowed
                            port: component.ports[i],
                            ips: appIps,
                            ...customConfigs[j],
                          };
                          configuredApps.push(configuredAppCustom);
                        }
                      }
                    } else { // does not have www, add with www
                      const adjustedDomain = `www.${portDomain.toLowerCase()}`;
                      if (adjustedDomain) {
                        const domainExistsB = configuredApps.find((a) => a.domain === adjustedDomain);
                        if (!domainExistsB) {
                          const configuredAppCustom = {
                            domain: adjustedDomain.replace('https://', '').replace('http://', '').replace(/[&/\\#,+()$~%'":*?<>{}]/g, ''), // . is allowed
                            port: component.ports[i],
                            ips: appIps,
                            ...customConfigs[j],
                          };
                          configuredApps.push(configuredAppCustom);
                        }
                      }
                    }
                    if (portDomain.includes('test.')) { // add domain without the test. prefix
                      const adjustedDomain = portDomain.toLowerCase().split('test.')[1];
                      if (adjustedDomain) {
                        const domainExistsB = configuredApps.find((a) => a.domain === adjustedDomain);
                        if (!domainExistsB) {
                          const configuredAppCustom = {
                            domain: adjustedDomain.replace('https://', '').replace('http://', '').replace(/[&/\\#,+()$~%'":*?<>{}]/g, ''), // . is allowed
                            port: component.ports[i],
                            ips: appIps,
                            ...customConfigs[j],
                          };
                          configuredApps.push(configuredAppCustom);
                        }
                      }
                    } else { // does not have test, add with test
                      const adjustedDomain = `test.${portDomain.toLowerCase()}`;
                      if (adjustedDomain) {
                        const domainExistsB = configuredApps.find((a) => a.domain === adjustedDomain);
                        if (!domainExistsB) {
                          const configuredAppCustom = {
                            domain: adjustedDomain.replace('https://', '').replace('http://', '').replace(/[&/\\#,+()$~%'":*?<>{}]/g, ''), // . is allowed
                            port: component.ports[i],
                            ips: appIps,
                            ...customConfigs[j],
                          };
                          configuredApps.push(configuredAppCustom);
                        }
                      }
                    }
                  }
                }
              });
              j += 1;
            }
          }
          // push main domain
          if (app.compose[0].ports[0]) {
            const mainApp = {
              domain: domains[domains.length - 1],
              port: app.compose[0].ports[0],
              ips: appIps,
              ...customConfigs[customConfigs.length - 1],
            };
            configuredApps.push(mainApp);
          } else if (app.compose[1] && app.compose[1].ports[0]) {
            const mainApp = {
              domain: domains[domains.length - 1],
              port: app.compose[1].ports[0],
              ips: appIps,
              ...customConfigs[customConfigs.length - 1],
            };
            configuredApps.push(mainApp);
          } else if (app.compose[2] && app.compose[2].ports[0]) {
            const mainApp = {
              domain: domains[domains.length - 1],
              port: app.compose[2].ports[0],
              ips: appIps,
              ...customConfigs[customConfigs.length - 1],
            };
            configuredApps.push(mainApp);
          } else if (app.compose[3] && app.compose[3].ports[0]) {
            const mainApp = {
              domain: domains[domains.length - 1],
              port: app.compose[3].ports[0],
              ips: appIps,
              ...customConfigs[customConfigs.length - 1],
            };
            configuredApps.push(mainApp);
          } else if (app.compose[4] && app.compose[4].ports[0]) {
            const mainApp = {
              domain: domains[domains.length - 1],
              port: app.compose[4].ports[0],
              ips: appIps,
              ...customConfigs[customConfigs.length - 1],
            };
            configuredApps.push(mainApp);
          }
        }
        log.info(`Application ${app.name} is OK. Proceeding to FDM`);
      } else {
        log.warn(`Application ${app.name} is excluded. Not running properly?`);
        if (mandatoryApps.includes(app.name)) {
          throw new Error(`Application ${app.name} is not running well PANIC.`);
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
    const haproxyPathTemp = '/tmp/haproxytemp.cfg';
    await fs.writeFile(haproxyPathTemp, dataToWrite);
    const response = await cmdAsync(`sudo haproxy -f ${haproxyPathTemp} -c`);
    if (response.includes('Configuration file is valid')) {
      // write and reload
      const haproxyPath = '/etc/haproxy/haproxy.cfg';
      await fs.writeFile(haproxyPath, dataToWrite);
      const execHAreload = 'sudo service haproxy reload';
      await cmdAsync(execHAreload);
    } else {
      throw new Error('Invalid HAPROXY config file!');
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

// services run every 6 mins
async function initializeServices() {
  myIP = await ipService.localIP();
  console.log(myIP);
  if (config.domainAppType === 'CNAME') {
    myFDMnameORip = config.fdmAppDomain;
  } else {
    myFDMnameORip = myIP;
  }
  if (myIP) {
    if (config.mainDomain === config.cloudflare.domain && !config.cloudflare.manageapp) {
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

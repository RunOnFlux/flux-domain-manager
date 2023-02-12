/* eslint-disable no-restricted-syntax */
const config = require('config');
const log = require('../../lib/log');
const serviceHelper = require('../serviceHelper');
const { executeCertificateOperations } = require('./cert');
const { DOMAIN_TYPE } = require('../constants');

// generates domain names for a given app specificatoin
function getUnifiedDomains(specifications) {
  const domains = [];
  const lowerCaseName = specifications.name.toLowerCase();
  if (specifications.version <= 3) { // app v1 cannot be spawned and do not exist
    // adding names for each port with new scheme {appname}_{portnumber}.app2.runonflux.io
    for (let i = 0; i < specifications.ports.length; i += 1) {
      const portDomain = `${lowerCaseName}_${specifications.ports[i]}.${config.appSubDomain}.${config.mainDomain}`;
      domains.push(portDomain);
    }
  } else {
    // composed app
    for (const component of specifications.compose) {
      // same for composed apps, adding for each port with new scheme {appname}_{portnumber}.app2.runonflux.io
      for (let i = 0; i < component.ports.length; i += 1) {
        const portDomain = `${lowerCaseName}_${component.ports[i]}.${config.appSubDomain}.${config.mainDomain}`;
        domains.push(portDomain);
      }
    }
  }
  // finally push general name which is alias to first port
  const mainDomain = `${lowerCaseName}.${config.appSubDomain}.${config.mainDomain}`;
  domains.push(mainDomain);
  return domains;
}

// gets custom domains set by user for their applications
function getCustomDomains(app) {
  const domains = [];
  if (app.version <= 3) {
    for (let i = 0; i < app.ports.length; i += 1) {
      const portDomains = app.domains[i].split(',');
      portDomains.forEach((portDomain) => {
        if (portDomain && portDomain.includes('.') && portDomain.length >= 3 && !portDomain.toLowerCase().endsWith(`${config.appSubDomain}.${config.mainDomain}`)) {
          let domain = portDomain.replace('https://', '').replace('http://', '').replace(/[&/\\#,+()$~%'":*?<>{}]/g, ''); // . is allowed
          if (domain.includes('www.')) {
            // eslint-disable-next-line prefer-destructuring
            domain = domain.split('www.')[1];
          }
          domains.push(domain.toLowerCase());
          domains.push(`www.${domain.toLowerCase()}`);
          domains.push(`test.${domain.toLowerCase()}`);
        }
      });
    }
  } else {
    for (const component of app.compose) {
      for (let i = 0; i < component.ports.length; i += 1) {
        const portDomains = component.domains[i].split(',');
        portDomains.forEach((portDomain) => {
          if (portDomain && portDomain.includes('.') && portDomain.length >= 3 && !portDomain.toLowerCase().endsWith(`${config.appSubDomain}.${config.mainDomain}`)) {
            let domain = portDomain.replace('https://', '').replace('http://', '').replace(/[&/\\#,+()$~%'":*?<>{}]/g, ''); // . is allowed
            if (domain.includes('www.')) {
            // eslint-disable-next-line prefer-destructuring
              domain = domain.split('www.')[1];
            }
            domains.push(domain.toLowerCase());
            domains.push(`www.${domain.toLowerCase()}`);
            domains.push(`test.${domain.toLowerCase()}`);
          }
        });
      }
    }
  }
  return domains;
}

async function processApplications(specifications, myFDMnameORip, myIP) {
  const processedApplications = [];
  for (const appSpecs of specifications) {
    if (config.whiteListedApps.length) {
      // exclude not whitelisted apps
      if (!serviceHelper.matchRule(appSpecs.name, config.whiteListedApps)) {
        // eslint-disable-next-line no-continue
        continue;
      }
    }
    if (config.blackListedApps.length) {
    // exclude blacklisted apps
      if (serviceHelper.matchRule(appSpecs.name, config.blackListedApps)) {
      // eslint-disable-next-line no-continue
        continue;
      }
    }

    log.info(`Adjusting domains and ssl for ${appSpecs.name}`);
    if (appSpecs.name === 'themok6') {
      for (const component of appSpecs.compose) {
        component.domains = ['themok.io'];
      }
    } else if (appSpecs.name.startsWith('themok')) {
      for (const component of appSpecs.compose) {
        component.domains = [''];
      }
    } else if (appSpecs.name === 'Jetpack2') {
      appSpecs.compose[0].domains = ['cloud.runonflux.io'];
    }
    const domains = getUnifiedDomains(appSpecs);
    const customDomains = getCustomDomains(appSpecs);
    const portLength = appSpecs.version <= 3 ? appSpecs.ports.length : appSpecs.compose.reduce(
      (p, c) => p + c.ports.length, // ports += 1; // component name itself not required in new scheme
      0,
    );

    if (domains.length === portLength + 1) {
      // eslint-disable-next-line no-await-in-loop
      const domainOperationsSuccessful = await executeCertificateOperations(domains, DOMAIN_TYPE.FDM, myFDMnameORip, myIP);
      if (domainOperationsSuccessful) {
        log.info(`Application domain and ssl for ${appSpecs.name} is ready`);
        processedApplications.push(appSpecs);
      } else {
        log.error(`Domain/ssl issues for ${appSpecs.name}`);
      }
      if (domainOperationsSuccessful && customDomains.length) {
        // eslint-disable-next-line no-await-in-loop
        const customCertOperationsSuccessful = await executeCertificateOperations(customDomains, DOMAIN_TYPE.CUSTOM, myFDMnameORip, myIP);
        if (customCertOperationsSuccessful) {
          log.info(`Application domain and ssl for custom domains of ${appSpecs.name} is ready`);
        } else {
          log.error(`Domain/ssl issues for custom domains of ${appSpecs.name}`);
        }
      }
    } else {
      log.error(`Application ${appSpecs.name} has wierd domain, settings. This is a bug.`);
    }
  }

  return processedApplications;
}

module.exports = {
  processApplications,
  getUnifiedDomains,
};

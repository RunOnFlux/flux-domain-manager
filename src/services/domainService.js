/* eslint-disable no-restricted-syntax */
const axios = require('axios');
const qs = require('qs');
const config = require('config');
const nodecmd = require('node-cmd');
const util = require('util');
const fs = require('fs').promises;
const fsSync = require('fs');
const log = require('../lib/log');
const serviceHelper = require('./serviceHelper');
const ipService = require('./ipService');
const fluxService = require('./fluxService');
const haproxyTemplate = require('./haproxyTemplate');
const applicationChecks = require('./applicationChecks');

let myIP = null;

const axiosConfig = {
  timeout: 13456,
};

const cmdAsync = util.promisify(nodecmd.get);

let db = null;
const recordsCollection = config.database.mainDomain.collections.records;

const cloudFlareAxiosConfig = {
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${config.cloudflare.apiKey}`,
  },
};

// const uiBlackList = [];
// const apiBlackList = [];

async function listDNSRecords(name, content, type = 'A', page = 1, per_page = 100, records = []) {
  // https://api.cloudflare.com/#dns-records-for-a-zone-list-dns-records
  const query = {
    name,
    content,
    type,
    page,
    per_page,
  };
  const queryString = qs.stringify(query);
  const url = `${config.cloudflare.endpoint}zones/${config.cloudflare.zone}/dns_records?${queryString}`;
  const response = await axios.get(url, cloudFlareAxiosConfig);
  if (response.data.result_info.total_pages > page) {
    const recs = records.concat(response.data.result);
    return listDNSRecords(name, content, type, page + 1, per_page, recs);
  }
  const r = records.concat(response.data.result);
  return r;
}

// throw error above
async function deleteDNSRecord(id) {
  if (!id) {
    throw new Error('No DNS ID record specified');
  }
  // https://api.cloudflare.com/#dns-records-for-a-zone-delete-dns-record
  const url = `${config.cloudflare.endpoint}zones/${config.cloudflare.zone}/dns_records/${id}`;
  const response = await axios.delete(url, cloudFlareAxiosConfig);
  return response.data;
}

// throw error above
async function createDNSRecord(name, content, type = 'A', ttl = 1) {
  // https://api.cloudflare.com/#dns-records-for-a-zone-create-dns-record
  const data = {
    type,
    name,
    content,
    ttl,
  };
  const url = `${config.cloudflare.endpoint}zones/${config.cloudflare.zone}/dns_records`;
  const response = await axios.post(url, data, cloudFlareAxiosConfig);
  return response.data;
}

async function getAllRecordsDBAPI(req, res) {
  try {
    const database = db.db(config.database.mainDomain.database);
    const q = {};
    const p = {};
    const records = await serviceHelper.findInDatabase(database, recordsCollection, q, p);
    const resMessage = serviceHelper.createDataMessage(records);
    res.json(resMessage);
  } catch (error) {
    log.error(error);
    const errMessage = serviceHelper.createErrorMessage(error.message, error.name, error.code);
    res.json(errMessage);
  }
}

async function listDNSRecordsAPI(req, res) {
  try {
    const records = await listDNSRecords();
    const resMessage = serviceHelper.createDataMessage(records);
    res.json(resMessage);
  } catch (error) {
    log.error(error);
    const errMessage = serviceHelper.createErrorMessage(error.message, error.name, error.code);
    res.json(errMessage);
  }
}

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
      const isOK = await applicationChecks.checkMainFlux(ip);
      if (isOK) {
        fluxIPsForBalancing.push(ip);
        console.log(`adding ${ip} as backend`);
      }
      if (fluxIPsForBalancing.length > 150) { // maximum of 150 for load balancing
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
  } catch (error) {
    log.error(error);
  }
}

async function getAppSpecifications() {
  try {
    const fluxnodeList = await axios.get('https://api.runonflux.io/apps/globalappsspecifications', axiosConfig);
    if (fluxnodeList.data.status === 'success') {
      return fluxnodeList.data.data || [];
    }
    return [];
  } catch (e) {
    log.error(e);
    return [];
  }
}

async function getApplicationLocation(appName) {
  try {
    const fluxnodeList = await axios.get(`https://api.runonflux.io/apps/location/${appName}`, axiosConfig);
    if (fluxnodeList.data.status === 'success') {
      return fluxnodeList.data.data || [];
    }
    return [];
  } catch (e) {
    log.error(e);
    return [];
  }
}

function getUnifiedDomainsForApp(specifications) {
  const domainString = 'abcdefghijklmno'; // enough
  const lowerCaseName = specifications.name.toLowerCase();
  const domains = [];
  // flux specs dont allow more than 10 ports so domainString is enough
  for (let i = 0; i < specifications.ports.length; i += 1) {
    const portDomain = `${domainString[i]}.${lowerCaseName}.app.${config.mainDomain}`;
    domains.push(portDomain);
  }
  // finally push general name which is alias to first port
  const mainDomain = `${lowerCaseName}.app.${config.mainDomain}`;
  domains.push(mainDomain);
  return domains;
}

// return true if some domain operation was done
// return false if no domain operation was done
async function checkAndAdjustDNSrecordForDomain(domain) {
  try {
    const dnsRecords = await listDNSRecords(domain);
    // delete bad
    for (const record of dnsRecords) { // async inside
      if (myIP && typeof myIP === 'string' && (record.content !== myIP || record.proxied === true)) {
        // delete the record
        // eslint-disable-next-line no-await-in-loop
        await deleteDNSRecord(record.id); // may throw
        log.info(`Record ${record.id} on ${record.content} deleted`);
      }
    }
    const correctRecords = dnsRecords.filter((record) => (record.content === myIP && record.proxied === false));
    if (correctRecords.length === 0) {
      await createDNSRecord(domain, myIP);
      return true;
    }
    if (correctRecords.length > 1) {
      // delete all except the first one
      correctRecords.shift(); // remove first record from records to delete
      for (const record of correctRecords) { // async inside
        // delete the record
        // eslint-disable-next-line no-await-in-loop
        await deleteDNSRecord(record.id); // may throw
        log.info(`Duplicate Record ${record.id} on ${record.content} deleted`);
      }
      return true;
    }
    // only one record exists and is correct
    log.info(`Record for domain ${domain} is set correctly`);
    return false;
  } catch (error) {
    log.error(error);
    return true;
  }
}

async function checkCertificatePresetForDomain(domain) {
  try {
    const path = `/etc/ssl/fluxapps/${domain}.pem`;
    await fs.access(path); // only check if file exists. Does not check permissions
    const fileSize = fsSync.statSync(path).size;
    if (fileSize > 128) { // it can be an empty file.
      return true;
    }
    return false;
  } catch (error) {
    return false;
  }
}

async function obtainDomainCertificate(domain) { // let it throw
  const cmdToExec = `sudo certbot certonly --standalone -d ${domain} --non-interactive --agree-tos --email ${config.emailDomain} --http-01-port=8787`;
  const cmdToExecContinue = `sudo cat /etc/letsencrypt/live/${domain}/fullchain.pem /etc/letsencrypt/live/${domain}/privkey.pem | sudo tee /etc/ssl/${config.certFolder}/${domain}.pem`;
  const response = await cmdAsync(cmdToExec);
  if (response.includes('Congratulations')) {
    await cmdAsync(cmdToExecContinue);
  }
}

async function adjustAutoRenewalScriptForDomain(domain) { // let it throw
  const path = '/opt/update-certs.sh';
  try {
    await fs.readFile(path);
    const autoRenewScript = await fs.readFile(path, { encoding: 'utf-8' });
    const cert = `bash -c "cat /etc/letsencrypt/live/${domain}/fullchain.pem /etc/letsencrypt/live/${domain}/privkey.pem > /etc/ssl/${config.certFolder}/${domain}.pem"`;
    if (autoRenewScript.includes(cert)) {
      return;
    }
    // split the contents by new line
    const lines = autoRenewScript.split(/\r?\n/);
    lines.splice(6, 0, cert); // push cert to top behind #Concatenate...
    const file = lines.join('\n');
    await fs.writeFile(path, file, {
      mode: 0o755,
      flag: 'w',
      encoding: 'utf-8',
    });
  } catch (error) {
    // probably does not exist
    const beginning = `#!/usr/bin/env bash
# Renew the certificate
certbot renew --force-renewal --http-01-port=8787 --preferred-challenges http

# Concatenate new cert files, with less output (avoiding the use tee and its output to stdout)\n`;
    const ending = `
# Reload  HAProxy
service haproxy reload`;
    const cert = `bash -c "cat /etc/letsencrypt/live/${domain}/fullchain.pem /etc/letsencrypt/live/${domain}/privkey.pem > /etc/ssl/${config.certFolder}/${domain}.pem"\n`;
    const file = beginning + cert + ending;
    await fs.writeFile(path, file, {
      mode: 0o755,
      flag: 'w',
      encoding: 'utf-8',
    });
  }
}

async function createSSLDirectory() {
  const dir = `/etc/ssl/${config.certFolder}`;
  await fs.mkdir(dir, { recursive: true });
}

async function doDomainCertOperations(domains) {
  try {
    for (const appDomain of domains) {
      // check DNS
      // if DNS was adjusted for this domain, wait a minute
      // eslint-disable-next-line no-await-in-loop
      const wasDomainAdjusted = await checkAndAdjustDNSrecordForDomain(appDomain);
      if (wasDomainAdjusted) {
        log.info(`Domain ${appDomain} was adjusted on DNS`);
        // eslint-disable-next-line no-await-in-loop
        await serviceHelper.timeout(45 * 1000);
      }
      // check if we have certificate
      // eslint-disable-next-line no-await-in-loop
      const isCertificatePresent = await checkCertificatePresetForDomain(appDomain);
      if (!isCertificatePresent) {
        // if we dont have certificate, obtain it
        log.info(`Obtaning certificate for ${appDomain}`);
        // eslint-disable-next-line no-await-in-loop
        await obtainDomainCertificate(appDomain);
      }
      // eslint-disable-next-line no-await-in-loop
      const isCertificatePresentB = await checkCertificatePresetForDomain(appDomain);
      if (isCertificatePresentB) {
        // check if domain has autorenewal, if not, adjust it
        // eslint-disable-next-line no-await-in-loop
        await adjustAutoRenewalScriptForDomain(appDomain);
      } else {
        throw new Error(`Certificate not present for ${appDomain}`);
      }
    }
    return true;
  } catch (error) {
    log.error(error);
    return false;
  }
}

async function generateAndReplaceMainApplicationHaproxyConfig() {
  try {
    // get applications on the network
    const applicationSpecifications = await getAppSpecifications();
    // for every application do following
    // get name, ports
    // main application domain is name.app.domain, for every port we have domainstrin[i].name.app.domain
    // check and adjust dns record for missing domains
    // obtain certificate
    // add to renewal script
    // check if certificate exist
    // if all ok, add for creation of domain
    const appsOK = [];
    await createSSLDirectory();
    log.info('SSL directory checked');
    for (const appSpecs of applicationSpecifications) {
      log.info(`Adjusting domains and ssl for ${appSpecs.name}`);
      const domains = getUnifiedDomainsForApp(appSpecs);
      const { ports } = appSpecs;
      if (domains.length === ports.length + 1) {
        // eslint-disable-next-line no-await-in-loop
        const domainOperationsSuccessful = await doDomainCertOperations(domains);
        if (domainOperationsSuccessful) {
          log.info(`Application domain and ssl for ${appSpecs.name} is ready`);
          appsOK.push(appSpecs);
        } else {
          log.error(`Domain/ssl issues for ${appSpecs.name}`);
        }
      } else {
        log.error(`Application ${appSpecs.name} has wierd domain, settings. This is a bug.`);
      }
    }
    // continue with appsOK
    const configuredApps = []; // object of domain, port, ips for backend
    for (const app of appsOK) {
      log.info(`Configuring ${app.name}`);
      // eslint-disable-next-line no-await-in-loop
      const appLocations = await getApplicationLocation(app.name);
      if (appLocations > 0) {
        const appIps = [];
        appLocations.forEach((location) => {
          appIps.push(location.ip);
        });
        const domains = getUnifiedDomainsForApp(app);
        for (let i = 0; i < app.ports.length; i += 1) {
          const configuredApp = {
            domain: domains[i],
            port: app.ports[i],
            ips: appIps,
          };
          configuredApps.push(configuredApp);
        }
        const mainApp = {
          domain: domains[domains.length - 1],
          port: app.ports[0],
          ips: appIps,
        };
        configuredApps.push(mainApp);
        log.info(`Application ${app.name} is OK. Proceeding to FDM`);
      } else {
        log.warn(`Application ${app.name} is excluded. Not running properly?`);
      }
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
    }, 5 * 1000);
  } catch (error) {
    log.error(error);
    setTimeout(() => {
      generateAndReplaceMainApplicationHaproxyConfig();
    }, 5 * 1000);
  }
}

// this is run on CUSTOM domain. By other FDMs for application to have custom domain
async function startApplicationDomainService() {
  console.log('CUSTOM DOMAIN SERVICE UNAVAILABLE');
}

// only runs main FDM. Registeres and handles X.ui.runonflux.io and X.api.runonflux.io
async function startMainFluxDomainService() {
  /*
  // todo load balancing of main domain
  const myIP = await ipService.localIP();
  // check that my IP has A record for main UI, if not create
  // check that my IP has A record for main API, if not create
  // check that my IP is the only one with main UI, if not delete others
  // check that my IP is the only one with main API, if not delete others
  const ui = `home.${config.mainDomain}`;
  const api = `api.${config.mainDomain}`;
  const mainUIRecords = await listDNSRecords(ui);
  const mainAPIRecords = await listDNSRecords(api);
  // UI delete bad
  for (const record of mainUIRecords) { // async inside
    if (myIP && typeof myIP === 'string' && (record.content !== myIP || record.proxied === true)) {
      // delete the record
      try {
        // eslint-disable-next-line no-await-in-loop
        await deleteDNSRecord(record.id); // may throw
        log.info(`Record ${record.id} on main UI on ${record.content} deleted`);
      } catch (error) {
        log.error(error);
      }
    }
  }

  // API delete bad
  for (const record of mainAPIRecords) { // async inside
    if (myIP && typeof myIP === 'string' && (record.content !== myIP || record.proxied === true)) {
      // delete the record
      try {
        // eslint-disable-next-line no-await-in-loop
        await deleteDNSRecord(record.id); // may throw
        log.info(`Record ${record.id} on main API on ${record.content} deleted`);
      } catch (error) {
        log.error(error);
      }
    }
  }

  // UI check one correct
  // has to be A record, not proxied
  const correctUI = mainUIRecords.filter((record) => (record.content === myIP && record.proxied === false));
  if (correctUI.length === 0) {
    // register main ui record
    try {
      await createDNSRecord(ui, myIP);
    } catch (error) {
      log.error(error);
    }
  } else if (correctUI.length > 1) {
    // delete all except the first one
    correctUI.shift(); // remove first record from records to delete
    for (const record of correctUI) { // async inside
      // delete the record
      try {
        // eslint-disable-next-line no-await-in-loop
        await deleteDNSRecord(record.id); // may throw
        log.info(`Duplicate Record ${record.id} on main UI on ${record.content} deleted`);
      } catch (error) {
        log.error(error);
      }
    }
  } else {
    // only one record exists and is correct
    log.info('Main UI record is set correctly');
  }

  // API check one correct
  // has to be A record, not proxied
  const correctAPI = mainAPIRecords.filter((record) => (record.content === myIP && record.proxied === false));
  if (correctAPI.length === 0) {
    // register main api record
    try {
      await createDNSRecord(api, myIP);
    } catch (error) {
      log.error(error);
    }
  } else if (correctAPI.length > 1) {
    // delete all except the first one
    correctAPI.shift(); // remove first record from records to delete
    for (const record of correctAPI) { // async inside
      // delete the record
      try {
        // eslint-disable-next-line no-await-in-loop
        await deleteDNSRecord(record.id); // may throw
        log.info(`Duplicate Record ${record.id} on main API on ${record.content} deleted`);
      } catch (error) {
        log.error(error);
      }
    }
  } else {
    // only one record exists and is correct
    log.info('Main API record is set correctly');
  }
  // ---- MAIN domain adjustments done ----

  // get list of current nodes on Flux network
  // get list of current X.api and X.api on main domain
  // if flux node does not have a domain, assign it
  // adjust haproxy load balancing for new domains
  // if domain exists on IP and IP is not in list, remove it from haproxy load balancing. Add such a domain to blacklist
  */
  // ---- Flux nodes domain adjustments begin ----
  // COMMENTED OUT AS OF NOT MAXIMUM DOMAINS IN DNS LIMIT
  /*
  const fluxIPs = await fluxService.getFluxIPs();
  if (fluxIPs.length < 10) {
    throw new Error('Invalid Flux List');
  }
  const fluxIPsForUI = JSON.parse(JSON.stringify(fluxIPs));
  const fluxIPsForAPI = JSON.parse(JSON.stringify(fluxIPs));
  if (fluxIPsForUI.length < 10) {
    log.error('Unable to obtain correct flux nodes list');
    return;
  }
  const allRecords = await listDNSRecords();
  const uiRecords = allRecords.filter((record) => record.name.includes(`.${ui}`));
  const apiRecords = allRecords.filter((record) => record.name.includes(`.${api}`));
  for (const record of uiRecords) {
    if (fluxIPsForUI.includes(record.content)) {
      // check that proxied is false and name is as expected, otherwise delete
      // create correct
      const a = record.content.split('.');
      let UiIpString = '';
      for (let i = 0; i < 4; i += 1) {
        if (a[i].length === 3) {
          UiIpString += a[i];
        }
        if (a[i].length === 2) {
          UiIpString = `${UiIpString}0${a[i]}`;
        }
        if (a[i].length === 1) {
          UiIpString = `${UiIpString}00${a[i]}`;
        }
      }
      // ui record is long ip address (with trailing 0s) without dots followed by home.my.domain
      const expectedUIRecord = `${UiIpString}.${ui}`;
      if (record.name === expectedUIRecord && record.proxied === false) {
        // ALL OK. Remove Flux IP from fluxIpsForUI (so we have smaller array to use later on)
        const index = fluxIPsForUI.indexOf(record.content);
        if (index > -1) {
          fluxIPsForUI.splice(index, 1);
        }
      } else {
        // BAD record delete
        try {
          log.info(`Deleting bad node UI record on ${record.content}`);
          // eslint-disable-next-line no-await-in-loop
          await deleteDNSRecord(record.id); // may throw
        } catch (error) {
          log.error(error);
        }
      }
    } else {
      // this flux node ui is offline, add to blacklist for delete (if in blacklist for more than 24 hours)
      const isInBlacklist = uiBlackList.find((node) => node.ip === record.content);
      if (!isInBlacklist) {
        const timestamp = new Date().getTime();
        uiBlackList.push({
          ip: record.content,
          timestamp,
          id: record.id,
        });
      }
      // removal from haproxy load balancing immediately is done later on
    }
  }

  for (const record of apiRecords) {
    if (fluxIPsForAPI.includes(record.content)) {
      // check that proxied is false and name is as expected, otherwise delete
      // create correct
      const a = record.content.split('.');
      let ApiIpString = '';
      for (let i = 0; i < 4; i += 1) {
        if (a[i].length === 3) {
          ApiIpString += a[i];
        }
        if (a[i].length === 2) {
          ApiIpString = `${ApiIpString}0${a[i]}`;
        }
        if (a[i].length === 1) {
          ApiIpString = `${ApiIpString}00${a[i]}`;
        }
      }
      // api record is long ip address (with trailing 0s) without dots followed by api.my.domain
      const expectedAPIRecord = `${ApiIpString}.${api}`;
      if (record.name === expectedAPIRecord && record.proxied === false) {
        // ALL OK. Remove Flux IP from fluxIpsForAPI (so we have smaller array to use later on)
        const index = fluxIPsForAPI.indexOf(record.content);
        if (index > -1) {
          fluxIPsForAPI.splice(index, 1);
        }
      } else {
        // BAD record delete
        try {
          log.info(`Deleting bad node API record on ${record.content}`);
          // eslint-disable-next-line no-await-in-loop
          await deleteDNSRecord(record.id); // may throw
        } catch (error) {
          log.error(error);
        }
      }
    } else {
      // this flux node api is offline, add to blacklist for delete (if in blacklist for more than 24 hours)
      const isInBlacklist = apiBlackList.find((node) => node.ip === record.content);
      if (!isInBlacklist) {
        const timestamp = new Date().getTime();
        apiBlackList.push({
          ip: record.content,
          timestamp,
          id: record.id,
        });
      }
      // removal from haproxy load balancing immediately is done later on
    }
  }

  // register not registered UI domains
  for (const ip of fluxIPsForUI) {
    // register flux node ui record
    const a = ip.split('.');
    let UiIpString = '';
    for (let i = 0; i < 4; i += 1) {
      if (a[i].length === 3) {
        UiIpString += a[i];
      }
      if (a[i].length === 2) {
        UiIpString = `${UiIpString}0${a[i]}`;
      }
      if (a[i].length === 1) {
        UiIpString = `${UiIpString}00${a[i]}`;
      }
    }
    // ui record is long ip address (with trailing 0s) without dots followed by ui.my.domain
    const expectedUIRecord = `${UiIpString}.${ui}`;
    try {
      // eslint-disable-next-line no-await-in-loop
      await createDNSRecord(expectedUIRecord, ip);
      log.info(`Flux node ui domain created for ${ip}`);
    } catch (error) {
      log.error(error);
    }
  }

  // register not registered API domains
  for (const ip of fluxIPsForAPI) {
    // register flux node ui record
    const a = ip.split('.');
    let ApiIpString = '';
    for (let i = 0; i < 4; i += 1) {
      if (a[i].length === 3) {
        ApiIpString += a[i];
      }
      if (a[i].length === 2) {
        ApiIpString = `${ApiIpString}0${a[i]}`;
      }
      if (a[i].length === 1) {
        ApiIpString = `${ApiIpString}00${a[i]}`;
      }
    }
    // api record is long ip address (with trailing 0s) without dots followed by api.my.domain
    const expectedAPIRecord = `${ApiIpString}.${api}`;
    try {
      // eslint-disable-next-line no-await-in-loop
      await createDNSRecord(expectedAPIRecord, ip);
      log.info(`Flux node api domain created for ${ip}`);
    } catch (error) {
      log.error(error);
    }
  }

  // blacklisted domains are removed from DNS records after 24 hours of being in the list
  const currentTime = new Date().getTime();
  const day = 24 * 60 * 60 * 1000;
  const removeTime = currentTime - day;
  for (const blacklistedIP of uiBlackList) {
    if (blacklistedIP.timestamp < removeTime) {
      // eslint-disable-next-line no-await-in-loop
      await deleteDNSRecord(blacklistedIP.id);
      log.info(`Flux node ui domain removed for ${blacklistedIP.id}`);
      const index = uiBlackList.findIndex((r) => r.id === blacklistedIP.id);
      if (index > -1) {
        uiBlackList.splice(index, 1);
      }
    }
  }
  for (const blacklistedIP of apiBlackList) {
    if (blacklistedIP.timestamp < removeTime) {
      // eslint-disable-next-line no-await-in-loop
      await deleteDNSRecord(blacklistedIP.id);
      log.info(`Flux node api domain removed for ${blacklistedIP.id}`);
      const index = apiBlackList.findIndex((r) => r.id === blacklistedIP.id);
      if (index > -1) {
        apiBlackList.splice(index, 1);
      }
    }
  }

  // add to haproxy balancer ONLY the nodes that are in current flux IP list AND in DNS records before our adjustments
  const ipsForHaproxy = [];
  for (const ip of fluxIPs) {
    const a = ip.split('.');
    let IpString = '';
    for (let i = 0; i < 4; i += 1) {
      if (a[i].length === 3) {
        IpString += a[i];
      }
      if (a[i].length === 2) {
        IpString = `${IpString}0${a[i]}`;
      }
      if (a[i].length === 1) {
        IpString = `${IpString}00${a[i]}`;
      }
    }
    // both api and ui has to be registered
    const expectedUIRecord = `${IpString}.${ui}`;
    const expectedAPIRecord = `${IpString}.${api}`;
    const uiDNSRecord = allRecords.find((record) => record.content === ip && record.name === expectedUIRecord);
    const apiDNSRecord = allRecords.find((record) => record.content === ip && record.name === expectedAPIRecord);
    if (uiDNSRecord && apiDNSRecord) {
      ipsForHaproxy.push(ip);
    }
  }
  console.log(ipsForHaproxy);
  */

  // TODO adjust haproxy load balancing, certs
  // Note we are not checking if node is actually responding correctly on that domain. We are using haproxy health check for that
  // haproxy IPS for load balancing are equal to Flux IPs
  generateAndReplaceMainHaproxyConfig();
}

// services run every 6 mins
async function initializeServices() {
  myIP = await ipService.localIP();
  console.log(myIP);
  if (myIP) {
    if (config.mainDomain === config.cloudflare.domain && !config.cloudflare.manageapp) {
      startMainFluxDomainService();
      setInterval(() => {
        startMainFluxDomainService();
      }, 10 * 60 * 1000);
      log.info('Flux Main Node Domain Service initiated.');
    } else if (config.mainDomain === config.cloudflare.domain && config.cloudflare.manageapp) {
      // only runs on main FDM handles X.APP.runonflux.io
      generateAndReplaceMainApplicationHaproxyConfig();
      log.info('Flux Main Application Domain Service initiated.');
    } else {
      startApplicationDomainService();
      setInterval(() => {
        startApplicationDomainService();
      }, 10 * 60 * 1000);
      log.info('Flux Custom Application Domain Service initiated.');
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
    db = await serviceHelper.connectMongoDb();
    const database = db.db(config.database.mainDomain.database);
    database.collection(recordsCollection).createIndex({ ip: 1 }, { name: 'query for getting list of Flux node data associated to IP address' });
    database.collection(recordsCollection).createIndex({ domain: 1 }, { name: 'query for getting list of Flux node data associated to Domain' });
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
  getAllRecordsDBAPI,
  listDNSRecordsAPI,
  listDNSRecords,
  deleteDNSRecord,
  createDNSRecord,
};

/* eslint-disable no-restricted-syntax */
const axios = require('axios');
const qs = require('qs');
const config = require('config');
const nodecmd = require('node-cmd');
const util = require('util');
const fs = require('fs').promises;
const log = require('../lib/log');
const serviceHelper = require('./serviceHelper');
const ipService = require('./ipService');
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

// eslint-disable-next-line camelcase
async function listDNSRecords(name, content, type = 'A', page = 1, per_page = 100, records = []) {
  // https://api.cloudflare.com/#dns-records-for-a-zone-list-dns-records
  const query = {
    name,
    content,
    type,
    page,
    // eslint-disable-next-line camelcase
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
    const portDomain = `${domainString[i]}.${lowerCaseName}2.app.${config.mainDomain}`;
    domains.push(portDomain);
  }
  // finally push general name which is alias to first port
  const mainDomain = `${lowerCaseName}2.app.${config.mainDomain}`;
  domains.push(mainDomain);
  return domains;
}

async function generateAndReplaceKadenaApplicationHaproxyConfig() {
  try {
    // kadena apps on network
    const kdaNodeApplications = ['Kadena', 'KadenaNode', 'Kadena2', 'KadenaNode2', 'Kadena3', 'KadenaNode3','Kadena4', 'KadenaNode4', 'Kadena5', 'KadenaNode5'];
    const kdaDataApplications = ['Kadena', 'Kadena2', 'Kadena3', 'Kadena4', 'Kadena5'];
    let appLocationsNode = [];
    for (const app of kdaNodeApplications) {
      // eslint-disable-next-line no-await-in-loop
      const appLocationsNodeApp = await getApplicationLocation(app);
      appLocationsNode = appLocationsNode.concat(appLocationsNodeApp);
    }
    if (!appLocationsNode.length) {
      throw new Error('Kadena Node is not running properly. PANIC');
    }
    let appLocationsData = [];
    for (const app of kdaDataApplications) {
      // eslint-disable-next-line no-await-in-loop
      const appLocationsDataApp = await getApplicationLocation(app);
      appLocationsData = appLocationsData.concat(appLocationsDataApp);
    }
    if (!appLocationsData.length) {
      throw new Error('Kadena Data is not running properly. PANIC');
    }
    const appIpsNode = [];
    const appIpsData = [];
    // eslint-disable-next-line no-restricted-syntax
    for (const kdaNode of appLocationsNode) {
      // eslint-disable-next-line no-await-in-loop
      const appOK = await applicationChecks.checkKadenaApplication(kdaNode.ip.split(':')[0]);
      if (appOK) {
        console.log(kdaNode);
        appIpsNode.push(kdaNode.ip);
      }
      if (appIpsNode.length > 100) {
        break;
      }
    }
    if (appIpsNode.length < 50) {
      throw new Error(`PANIC Chainweb Node not sufficient. Nodes OK: ${appIpsData.length}`);
    }
    for (const kdaNode of appLocationsData) {
      // eslint-disable-next-line no-await-in-loop
      const appOK = await applicationChecks.checkKadenaDataApplication(kdaNode.ip.split(':')[0]);
      if (appOK) {
        console.log(kdaNode);
        appIpsData.push(kdaNode.ip);
      } else {
        console.log(`KDA DATA ${kdaNode.ip} not ok`);
      }
      if (appIpsData.length > 100) {
        break;
      }
    }
    if (appIpsData.length < 20) {
      throw new Error(`PANIC Chainweb Data not sufficient. Nodes OK: ${appIpsData.length}`);
    }
    const configuredApps = []; // object of domain, port, ips for backend
    const apps = [
      {
        name: 'KadenaChainWebNode',
        ports: [31350, 31351],
      },
      {
        name: 'KadenaChainWebData',
        ports: [31352],
      },
    ];
    for (const app of apps) {
      const domains = getUnifiedDomainsForApp(app);
      let appIps = appIpsNode;
      if (app.name === 'KadenaChainWebData') {
        appIps = appIpsData;
      }
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
    }

    const hc = await haproxyTemplate.createKadenaHaproxyConfig(configuredApps);
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
      generateAndReplaceKadenaApplicationHaproxyConfig();
    }, 4 * 60 * 1000);
  } catch (error) {
    log.error(error);
    setTimeout(() => {
      generateAndReplaceKadenaApplicationHaproxyConfig();
    }, 4 * 60 * 1000);
  }
}

// services run every 6 mins
async function initializeServices() {
  myIP = await ipService.localIP();
  console.log(myIP);
  if (myIP) {
    generateAndReplaceKadenaApplicationHaproxyConfig();
    log.info('Flux Kadena Application Domain Service initiated.');
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

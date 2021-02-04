const axios = require('axios');
const qs = require('qs');
const config = require('config');
const log = require('../lib/log');
const serviceHelper = require('./serviceHelper');
const ipService = require('./ipService');

let db = null;
const recordsCollection = config.database.mainDomain.collections.records;

const cloudFlareAxiosConfig = {
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${config.cloudflare.apiKey}`,
  },
};

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
  const response = await axios.delete(url, data, cloudFlareAxiosConfig);
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

// this is run on CUSTOM domain. By other FDMs for application to have custom domain
async function startApplicationDomainService() {
  console.log('CUSTOM DOMAIN SERVICE UNAVAILABLE');
}

// only runs main FDM. Registeres and handles X.ui.runonflux.io and X.api.runonflux.io
async function startMainFluxDomainService() {
  // 1. check that my IP has A record for main UI, if not create
  const ui = `ui.${config.mainDomain}`;
  const api = `api.${config.mainDomain}`;
  const mainUIRecords = await listDNSRecords(ui);
  const mainAPIRecords = await listDNSRecords(api);
  console.log(mainUIRecords);
  console.log(mainAPIRecords);
  // 2. check that my IP has A record for main API, if not create
  // 3. check that my IP is the only one with main UI, if not delete others
  // 4. check that my IP is the only one with main API, if not delete others

  // 5. get list of current nodes on Flux network
  // 6. get list of current X.api and X.api on main domain
  // 7. if flux node does not have a domain, assign it
  // 8. adjust haproxy load balancing for new domains
  // 8. if domain exists on IP and IP is not in list, remove it from haproxy load balancing. Add such a domain to blacklist
  // 9. blacklisted domains are removed from DNS records after 24 hours of being in the list
}

// only runs on main FDM handles X.MYAPP.runonflux.io
async function startApplicationFluxDomainService() {
  console.log('Application SERVICE UNAVAILABLE');
}

// services run every 6 mins
async function initializeServices() {
  const myIP = await ipService.localIP();
  console.log(myIP);
  if (myIP) {
    if (config.mainDomain === config.cloudflare.domain) {
      startMainFluxDomainService();
      setInterval(() => {
        startMainFluxDomainService();
      }, 6 * 60 * 1000);
      log.info('Flux Main Node Domain Service initiated.');
      // wait 3 mins so it runs separately
      setTimeout(() => {
        startApplicationFluxDomainService();
        setInterval(() => {
          startApplicationFluxDomainService();
        }, 6 * 60 * 1000);
      }, 3 * 60 * 1000);
      log.info('Flux Main Application Domain Service initiated.');
    } else {
      startApplicationDomainService();
      setInterval(() => {
        startApplicationDomainService();
      }, 6 * 60 * 1000);
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
    }, 5 * 30 * 1000);
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

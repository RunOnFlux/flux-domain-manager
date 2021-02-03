const axios = require('axios');
const qs = require('qs');
const config = require('config');
const log = require('../lib/log');
const serviceHelper = require('./serviceHelper');

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

async function start() {
  try {
    db = await serviceHelper.connectMongoDb().catch((error) => {
      log.error(error);
      throw error;
    });
    const database = db.db(config.database.mainDomain.database);
    database.collection(recordsCollection).createIndex({ ip: 1 }, { name: 'query for getting list of Flux node data associated to IP address' });
    database.collection(recordsCollection).createIndex({ domain: 1 }, { name: 'query for getting list of Flux node data associated to Domain' });
    log.info('Initiating FDM API services...');
  } catch (e) {
    // restart service after 5 mins
    log.error(e);
    setTimeout(() => {
      start();
    }, 5 * 30 * 1000);
  }
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

module.exports = {
  start,
  getAllRecordsDBAPI,
  listDNSRecordsAPI,
  listDNSRecords,
  deleteDNSRecord,
  createDNSRecord,
};

const { default: axios } = require('axios');
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

async function getAllRecordsDB(req, res) {
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

async function start() {
  try {
    db = await serviceHelper.connectMongoDb().catch((error) => {
      log.error(error);
      throw error;
    });
    const database = db.db(config.database.mainDomain.database);
    database.collection(recordsCollection).createIndex({ ip: 1 }, { name: 'query for getting list of Flux node data associated to IP address' });
    database.collection(recordsCollection).createIndex({ domain: 1 }, { name: 'query for getting list of Flux node data associated to Domain' });
    log.info('Initiating Domain API services...');
  } catch (e) {
    // restart service after 5 mins
    log.error(e);
    setTimeout(() => {
      start();
    }, 5 * 30 * 1000);
  }
}

async function listDNSRecords(req, res) {
  try {
    const url = `${config.cloudflare.endpoint}zones/${config.cloudflare.zone}/dns_records`;
    const records = await axios.get(url, cloudFlareAxiosConfig);
    const resMessage = serviceHelper.createDataMessage(records.data);
    res.json(resMessage);
  } catch (error) {
    log.error(error);
    const errMessage = serviceHelper.createErrorMessage(error.message, error.name, error.code);
    res.json(errMessage);
  }
}

module.exports = {
  start,
  getAllRecordsDB,
  listDNSRecords,
};

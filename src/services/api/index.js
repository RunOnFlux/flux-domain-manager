const config = require('config');
const { listDNSRecords } = require('../domain/dns');
const serviceHelper = require('../serviceHelper');
const log = require('../../lib/log');

const recordsCollection = config.database.mainDomain.collections.records;

async function getAllRecordsDBAPI(req, res) {
  try {
    const db = await serviceHelper.connectMongoDb();
    const database = db.db(config.database.mainDomain.database);
    database.collection(recordsCollection).createIndex({ ip: 1 }, { name: 'query for getting list of Flux node data associated to IP address' });
    database.collection(recordsCollection).createIndex({ domain: 1 }, { name: 'query for getting list of Flux node data associated to Domain' });
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
  getAllRecordsDBAPI,
  listDNSRecordsAPI,
};

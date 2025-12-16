const config = require('config');
const { listDNSRecords } = require('../domain/dns');
const serviceHelper = require('../serviceHelper');
const log = require('../../lib/log');
const domainService = require('../domainService');

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

async function pkiValidation(req, res) {
  try {
    let { id } = req.params;
    id = id || req.query.id;
    console.log(id);
    res.send('ca3-b1970edefd4c4eacb7a7b70c41fc433e');
  } catch (error) {
    res.status(404).send('Not found!');
  }
}

function getAppIpsAPI(req, res) {
  try {
    let { appname } = req.params;
    appname = appname || req.query.appname;

    if (!appname) {
      const errMessage = serviceHelper.createErrorMessage('appname parameter is required', 'ValidationError', 400);
      return res.status(400).json(errMessage);
    }

    const appNameLower = appname.toLowerCase();
    const {
      nonGApps, gApps, nonGAppsInitialized, gAppsInitialized,
    } = domainService.getConfiguredApps();

    if (!nonGAppsInitialized || !gAppsInitialized) {
      const errMessage = serviceHelper.createErrorMessage(
        'Service is starting up - initial application processing has not completed yet',
        'ServiceUnavailable',
        503,
      );
      return res.status(503).json(errMessage);
    }

    const allApps = [...nonGApps, ...gApps];

    const matchingApps = allApps.filter((app) => app.name.toLowerCase() === appNameLower);

    if (matchingApps.length === 0) {
      const errMessage = serviceHelper.createErrorMessage(`App '${appname}' not found in HAProxy configuration`, 'NotFoundError', 404);
      return res.status(404).json(errMessage);
    }

    const uniqueIps = [...new Set(matchingApps.flatMap((app) => app.ips.map((ip) => ip.split(':')[0])))];

    const resMessage = serviceHelper.createDataMessage({
      appName: matchingApps[0].name,
      ips: uniqueIps,
      count: uniqueIps.length,
    });
    return res.json(resMessage);
  } catch (error) {
    log.error(error);
    const errMessage = serviceHelper.createErrorMessage(error.message, error.name, error.code);
    return res.status(500).json(errMessage);
  }
}

module.exports = {
  getAllRecordsDBAPI,
  listDNSRecordsAPI,
  pkiValidation,
  getAppIpsAPI,
};

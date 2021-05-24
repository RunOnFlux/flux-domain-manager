/* eslint-disable no-restricted-syntax */
const axios = require('axios');
const https = require('https');
const qs = require('qs');
const config = require('config');
const nodecmd = require('node-cmd');
const util = require('util');
const fs = require('fs').promises;
const log = require('../lib/log');
const serviceHelper = require('./serviceHelper');
const ipService = require('./ipService');
const fluxService = require('./fluxService');
const haproxyTemplate = require('./haproxyTemplate');

const cmdAsync = util.promisify(nodecmd.get);

let db = null;
const recordsCollection = config.database.mainDomain.collections.records;

const cloudFlareAxiosConfig = {
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${config.cloudflare.apiKey}`,
  },
};

const axiosConfig = {
  timeout: 3456,
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

async function getApplicationLocation(ip) {
  try {
    const fluxnodeList = await axios.get(`http://${ip}:16127/apps/location/FluxRosettaServer`, axiosConfig);
    if (fluxnodeList.data.status === 'success') {
      return fluxnodeList.data.data || [];
    }
    return [];
  } catch (e) {
    log.error(e);
    return [];
  }
}

async function checkRosettaSynced(ip, height) {
  try {
    const agent = new https.Agent({
      rejectUnauthorized: false,
    });
    const data = {
      network_identifier: {
        blockchain: 'flux',
        network: 'mainnet',
      },
      block_identifier: {
        index: height - 30,
      },
    };
    const rosettaData = await axios.post(`http://${ip}:38080/block`, data, { httpsAgent: agent, timeout: 3456 });
    return rosettaData.data.block.block_identifier.index;
  } catch (e) {
    // log.error(e);
    return false;
  }
}

async function getRosettaHeight(ip) {
  try {
    const agent = new https.Agent({
      rejectUnauthorized: false,
    });
    const data = {
      network_identifier: {
        blockchain: 'flux',
        network: 'mainnet',
      },
    };
    const rosettaData = await axios.post(`http://${ip}:38080/network/status`, data, { httpsAgent: agent, timeout: 3456 });
    return rosettaData.data.current_block_identifier.index;
  } catch (e) {
    // log.error(e);
    return -1;
  }
}

function checkheightOK(height) {
  const currentTime = new Date().getTime();
  const baseTime = 1621822807000;
  const baseHeight = 866312;
  const timeDifference = currentTime - baseTime;
  const blocksPassedInDifference = (timeDifference / 120000); // 120 secs
  const currentBlockEstimation = baseHeight + blocksPassedInDifference;
  const minimumAcceptedBlockHeight = currentBlockEstimation - 30; // allow being off sync for 30 blocks; 1 hour
  if (height > minimumAcceptedBlockHeight) {
    return true;
  }
  return false;
}

async function generateAndReplaceMainApplicationHaproxyConfig() {
  try {
    const domainA = `online.rosetta.${config.mainDomain}`;
    const domainB = `offline.rosetta.${config.mainDomain}`;
    const portA = 38080;
    const portB = 38081;
    const fluxIPs = await fluxService.getFluxIPs();
    if (fluxIPs.length < 10) {
      throw new Error('Invalid Flux List');
    }

    // get locations of the applications
    // check if they run properly there (aka health status check todo do it in flux)
    // ports, create stuff

    // choose 10 random nodes and get chainwebnode locations from them
    const stringOfTenChars = 'qwertyuiop';
    const rosettaNodesLocations = [];
    // eslint-disable-next-line no-restricted-syntax, no-unused-vars
    for (const index of stringOfTenChars) { // async inside
      const randomNumber = Math.floor((Math.random() * fluxIPs.length));
      // eslint-disable-next-line no-await-in-loop
      const rosettaNodes = await getApplicationLocation(fluxIPs[randomNumber]);
      const rosettaNodesValid = rosettaNodes.filter((node) => (node.hash === '9de3965ebe3a4fac4d8edae9d3634756ae19cff59cdfdf8de96bced0dade9e37'));
      rosettaNodesValid.forEach((node) => {
        rosettaNodesLocations.push(node.ip);
      });
    }
    // create a set of it so we dont have duplicates
    const rosettaOK = [...new Set(rosettaNodesLocations)]; // continue running checks

    const syncedrosettaNodes = [];
    // eslint-disable-next-line no-restricted-syntax
    for (const rosettaNode of rosettaOK) {
      // eslint-disable-next-line no-await-in-loop
      const height = await getRosettaHeight(rosettaNode);
      if (checkheightOK(height)) {
        // eslint-disable-next-line no-await-in-loop
        const synced = await checkRosettaSynced(rosettaNode, height);
        if (synced) {
          syncedrosettaNodes.push(rosettaNode);
        }
      }
    }

    if (syncedrosettaNodes.length < 3) {
      return;
    }

    const hc = await haproxyTemplate.createMainAppRosettaHaproxyConfig(domainA, domainB, syncedrosettaNodes, portA, portB);
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

async function startApplicationFluxDomainService() {
  generateAndReplaceMainApplicationHaproxyConfig();
}

// services run every 6 mins
async function initializeServices() {
  const myIP = await ipService.localIP();
  console.log(myIP);
  if (myIP) {
    startApplicationFluxDomainService();
    setInterval(() => {
      startApplicationFluxDomainService();
    }, 30 * 60 * 1000);
    log.info('Flux Main Application Domain Service initiated.');
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

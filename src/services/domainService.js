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

async function getApplicationLocation(ip, application) {
  try {
    const fluxnodeList = await axios.get(`http://${ip}:16127/apps/location/${application}`, axiosConfig);
    if (fluxnodeList.data.status === 'success') {
      return fluxnodeList.data.data || [];
    }
    return [];
  } catch (e) {
    log.error(e);
    return [];
  }
}

function checkheightOKksm(height) {
  const currentTime = new Date().getTime();
  const baseTime = 1622640282000;
  const baseHeight = 7739485;
  const timeDifference = currentTime - baseTime;
  const blocksPassedInDifference = (timeDifference / 6000); // 6 secs
  const currentBlockEstimation = baseHeight + blocksPassedInDifference;
  const minimumAcceptedBlockHeight = currentBlockEstimation - 600; // allow being off sync for 600 blocks; 1 hour
  console.log(minimumAcceptedBlockHeight);
  if (height > minimumAcceptedBlockHeight) {
    return true;
  }
  return false;
}

function checkheightOKdot(height) {
  const currentTime = new Date().getTime();
  const baseTime = 1622640408000;
  const baseHeight = 5331005;
  const timeDifference = currentTime - baseTime;
  const blocksPassedInDifference = (timeDifference / 6000); // 6 secs
  const currentBlockEstimation = baseHeight + blocksPassedInDifference;
  const minimumAcceptedBlockHeight = currentBlockEstimation - 600; // allow being off sync for 600 blocks; 1 hour
  console.log(minimumAcceptedBlockHeight);
  if (height > minimumAcceptedBlockHeight) {
    return true;
  }
  return false;
}

async function getPolkaNetworkHeight(ip, port) {
  try {
    const max = 1000000;
    const min = 1;

    const data = {
      jsonrpc: '2.0',
      method: 'system_syncState',
      params: [],
      id: Math.floor(Math.random() * (max - min + 1)) + min,
    };
    const AConfig = {
      headers: {
        'Content-Type': 'application/json',
      },
      timeout: 3456,
    };
    const rosettaData = await axios.post(`http://${ip}:${port}/network/status`, data, AConfig);
    console.log(rosettaData.data.result);
    return rosettaData.data.result.currentBlock;
  } catch (e) {
    // log.error(e);
    return -1;
  }
}

async function generateAndReplaceMainApplicationHaproxyConfig() {
  try {
    const dotApplication = 'PolkadotNode';
    const dotDomain = `dot.${config.mainDomain}`;
    const rpcDotDomain = `rpc.dot.${config.mainDomain}`;
    const wsDotDomain = `ws.dot.${config.mainDomain}`;
    const rpcDotPort = 31115;
    const wsDotPort = 31114;

    const ksmApplication = 'KusamaNode';
    const ksmDomain = `ksm.${config.mainDomain}`;
    const rpcKsmDomain = `rpc.ksm.${config.mainDomain}`;
    const wsKsmDomain = `ws.ksm.${config.mainDomain}`;
    const rpcKsmPort = 31112;
    const wsKsmPort = 31111;

    const fluxIPs = await fluxService.getFluxIPs();
    if (fluxIPs.length < 10) {
      throw new Error('Invalid Flux List');
    }

    // get locations of the applications
    // check if they run properly there (aka health status check todo do it in flux)
    // ports, create stuff

    // choose 10 random nodes and get chainwebnode locations from them
    const stringOfTenChars = 'qwertyuiop';
    const dotNodesLocation = [];
    const ksmNodesLocation = [];
    // eslint-disable-next-line no-restricted-syntax, no-unused-vars
    for (const index of stringOfTenChars) { // async inside
      const randomNumber = Math.floor((Math.random() * fluxIPs.length));
      // eslint-disable-next-line no-await-in-loop
      const dotNodes = await getApplicationLocation(fluxIPs[randomNumber], dotApplication);
      const dotNodesValid = dotNodes.filter((node) => (node.hash === '90531ca8889897703e231180b46278386d4b418ccf793269b462bb5ace6692bf'));
      dotNodesValid.forEach((node) => {
        dotNodesLocation.push(node.ip);
      });
    }

    // eslint-disable-next-line no-unused-vars
    for (const index of stringOfTenChars) { // async inside
      const randomNumber = Math.floor((Math.random() * fluxIPs.length));
      // eslint-disable-next-line no-await-in-loop
      const ksmNodes = await getApplicationLocation(fluxIPs[randomNumber], ksmApplication);
      const ksmNodesValid = ksmNodes.filter((node) => (node.hash === '66eb2f5c087764a3d4af7ea9dccbd10ae7142addf607ebb2221c0996e77fbc89'));
      ksmNodesValid.forEach((node) => {
        ksmNodesLocation.push(node.ip);
      });
    }

    // create a set of it so we dont have duplicates
    const dotOK = [...new Set(dotNodesLocation)]; // continue running checks
    const ksmOK = [...new Set(ksmNodesLocation)]; // continue running checks

    const syncedDOTNodes = [];
    const syncedKSMNodes = [];
    // eslint-disable-next-line no-restricted-syntax
    for (const node of dotOK) {
      // eslint-disable-next-line no-await-in-loop
      const height = await getPolkaNetworkHeight(node, rpcDotPort);
      if (checkheightOKdot(height)) {
        syncedDOTNodes.push(node);
      }
    }

    for (const node of ksmOK) {
      // eslint-disable-next-line no-await-in-loop
      const height = await getPolkaNetworkHeight(node, rpcKsmPort);
      if (checkheightOKksm(height)) {
        syncedKSMNodes.push(node);
      }
    }

    if (syncedDOTNodes.length < 3) {
      return;
    }

    if (syncedKSMNodes.length < 3) {
      return;
    }

    const dotConfigA = {
      domain: rpcDotDomain,
      port: rpcDotPort,
      ips: syncedDOTNodes,
    };

    const dotConfigB = {
      domain: wsDotDomain,
      port: wsDotPort,
      ips: syncedDOTNodes,
    };

    const dotConfigC = {
      domain: dotDomain,
      port: rpcDotPort,
      ips: syncedDOTNodes,
    };

    const ksmConfigA = {
      domain: rpcKsmDomain,
      port: rpcKsmPort,
      ips: syncedKSMNodes,
    };

    const ksmConfigB = {
      domain: wsKsmDomain,
      port: wsKsmPort,
      ips: syncedKSMNodes,
    };

    const ksmConfigC = {
      domain: ksmDomain,
      port: rpcKsmPort,
      ips: syncedKSMNodes,
    };

    const domainsToDo = [dotConfigA, dotConfigB, dotConfigC, ksmConfigA, ksmConfigB, ksmConfigC];

    const hc = await haproxyTemplate.createAppsHaproxyConfig(domainsToDo);
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

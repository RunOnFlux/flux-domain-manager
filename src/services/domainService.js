/* eslint-disable no-restricted-syntax */
const axios = require('axios');
const qs = require('qs');
const config = require('config');
const log = require('../lib/log');
const serviceHelper = require('./serviceHelper');
const ipService = require('./ipService');
const fluxService = require('./fluxService');

let db = null;
const recordsCollection = config.database.mainDomain.collections.records;

const cloudFlareAxiosConfig = {
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${config.cloudflare.apiKey}`,
  },
};

const uiBlackList = [];
const apiBlackList = [];

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

// this is run on CUSTOM domain. By other FDMs for application to have custom domain
async function startApplicationDomainService() {
  console.log('CUSTOM DOMAIN SERVICE UNAVAILABLE');
}

// only runs main FDM. Registeres and handles X.ui.runonflux.io and X.api.runonflux.io
async function startMainFluxDomainService() {
  const myIP = await ipService.localIP();
  // check that my IP has A record for main UI, if not create
  // check that my IP has A record for main API, if not create
  // check that my IP is the only one with main UI, if not delete others
  // check that my IP is the only one with main API, if not delete others
  const ui = `ui.${config.mainDomain}`;
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

  // ---- Flux nodes domain adjustments begin ----
  const fluxIPs = await fluxService.getFluxIPs();
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
      // ui record is long ip address (with trailing 0s) without dots followed by ui.my.domain
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

  // TODO adjust haproxy load balancing, certs
  // Note we are not checking if node is actually responding correctly on that domain. We are using haproxy health check for that
  console.log(ipsForHaproxy);
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

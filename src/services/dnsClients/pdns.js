const axios = require('axios');
const config = require('config');
const https = require('https');

// set rejectUnauthorized to false to accept self signed certificates.
const agent = new https.Agent({
  rejectUnauthorized: false,
});
const pDNSAxiosConfig = {
  headers: {
    'X-API-Key': config.pDNS.apiKey,
  },
  httpsAgent: agent,
};

async function createDNSRecord(name, content, type = config.domainAppType, ttl = 60, skipDNSRecordCreation = config.skipDNSRecordCreation) {
  if (skipDNSRecordCreation) {
    return true;
  }
  if (!name.endsWith(`${config.appSubDomain}.${config.mainDomain}`)) {
    throw new Error('Invalid DNS record to create specified');
  }
  let adjustedContent = content;
  if (type === 'CNAME') {
    adjustedContent = `${content}.`;
  }
  const data = {
    rrsets: [{
      name: `${name}.`,
      type,
      ttl,
      changetype: 'REPLACE',
      records: [{ content: adjustedContent, disabled: false }],
    }],
  };
  const url = `${config.pDNS.endpoint}zones/${config.pDNS.zone}`;
  const response = await axios.patch(url, data, pDNSAxiosConfig);
  return response.data;
}

// Lists DNS records for given input, will return all if no input provided
async function listDNSRecords(name, content, type = 'all', page = 1, perPage = 100, records = []) { // eslint-disable-line no-unused-vars
  // https://api.cloudflare.com/#dns-records-for-a-zone-list-dns-records
  let adjustedName = name;
  if (!name) {
    adjustedName = '*';
  }
  const url = `${config.pDNS.endpoint}search-data?q=${adjustedName}&object_type=record`;
  const response = await axios.get(url, pDNSAxiosConfig);
  let filteredData = response.data;
  if (content) {
    filteredData = filteredData.filter((data) => data.content === content);
  }
  if (type !== 'all') {
    filteredData = filteredData.filter((data) => data.type === type);
  }
  return filteredData;
}

// Deletes DNS records matching given parameters (for pDNS)
async function deleteDNSRecord(name, content, type = 'A', ttl = 60) {
  if (!name.endsWith(`${config.appSubDomain}.${config.mainDomain}`)) {
    throw new Error('Invalid DNS record to delete specified');
  }
  const data = {
    rrsets: [{
      name,
      type,
      ttl,
      changetype: 'DELETE',
      records: [{ content, disabled: false }],
    }],
  };
  const url = `${config.pDNS.endpoint}zones/${config.pDNS.zone}`;
  const response = await axios.patch(url, data, pDNSAxiosConfig);
  return response.data;
}

module.exports = {
  createDNSRecord,
  listDNSRecords,
  deleteDNSRecord,
};

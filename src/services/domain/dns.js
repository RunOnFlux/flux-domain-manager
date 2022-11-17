/* eslint-disable no-restricted-syntax */
const axios = require('axios');
const qs = require('qs');
const config = require('config');

const https = require('https');

const cloudFlareAxiosConfig = {
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${config.cloudflare.apiKey}`,
  },
};

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
// Lists DNS records for given input, will return all if no input provided
async function listDNSRecords(name, content, type = 'all', page = 1, perPage = 100, records = []) {
  // https://api.cloudflare.com/#dns-records-for-a-zone-list-dns-records
  if (config.cloudflare.enabled) {
    const query = {
      name,
      content,
      page,
      per_page: perPage,
    };
    if (type !== 'all') {
      query.type = type;
    }
    const queryString = qs.stringify(query);
    const url = `${config.cloudflare.endpoint}zones/${config.cloudflare.zone}/dns_records?${queryString}`;
    const response = await axios.get(url, cloudFlareAxiosConfig);
    if (response.data.result_info.total_pages > page) {
      const recs = records.concat(response.data.result);
      return listDNSRecords(name, content, type, page + 1, perPage, recs);
    }
    const r = records.concat(response.data.result);
    return r;
  } if (config.pDNS.enabled) {
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
  throw new Error('No DNS provider is enable!');
}

// Deletes DNS record for given id (for cloudflare)
async function deleteDNSRecordCloudflare(record) {
  if (!record) {
    throw new Error('No DNS record specified');
  }
  const { id } = record;
  if (!id) {
    throw new Error('No DNS ID record specified');
  }
  if (!record.name.endsWith(`${config.appSubDomain}.${config.mainDomain}`)) {
    throw new Error('Invalid DNS record to delete specified');
  }
  // https://api.cloudflare.com/#dns-records-for-a-zone-delete-dns-record
  const url = `${config.cloudflare.endpoint}zones/${config.cloudflare.zone}/dns_records/${id}`;
  const response = await axios.delete(url, cloudFlareAxiosConfig);
  return response.data;
}

// Deletes DNS records matching given parameters (for pDNS)
async function deleteDNSRecordPDNS(name, content, type = 'A', ttl = 60) {
  if (!name.endsWith(`${config.appSubDomain}.${config.mainDomain}`)) {
    throw new Error('Invalid DNS record to delete specified');
  }
  if (config.pDNS.enabled) {
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
  throw new Error('No DNS provider is enable!');
}

// Creates new DNS record
async function createDNSRecord(name, content, type = config.domainAppType, ttl = 60, skipDNSRecordCreation = config.skipDNSRecordCreation) {
  if (skipDNSRecordCreation) {
    return true;
  }
  if (!name.endsWith(`${config.appSubDomain}.${config.mainDomain}`)) {
    throw new Error('Invalid DNS record to create specified');
  }
  if (config.cloudflare.enabled) {
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
  } if (config.pDNS.enabled) {
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
  throw new Error('No DNS provider is not enabled!');
}

module.exports = {
  listDNSRecords,
  createDNSRecord,
  deleteDNSRecordCloudflare,
  deleteDNSRecordPDNS,
};

const axios = require('axios');
const config = require('config');
const qs = require('qs');

const AXIOS_CONFIG = {
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${config.cloudflare.apiKey}`,
  },
};

async function createDNSRecord(name, content, type = config.domainAppType, ttl = 60, skipDNSRecordCreation = config.skipDNSRecordCreation) {
  if (skipDNSRecordCreation) {
    return true;
  }
  if (!name.endsWith(`${config.appSubDomain}.${config.mainDomain}`)) {
    throw new Error('Invalid DNS record to create specified');
  }
  const data = {
    type,
    name,
    content,
    ttl,
  };
  const url = `${config.cloudflare.endpoint}zones/${config.cloudflare.zone}/dns_records`;
  const response = await axios.post(url, data, AXIOS_CONFIG);
  return response.data;
}

// Deletes DNS record for given id (for cloudflare)
async function deleteDNSRecord(record) {
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
  const response = await axios.delete(url, AXIOS_CONFIG);
  return response.data;
}

async function listDNSRecords(
  name,
  content,
  type = 'all',
  page = 1,
  perPage = 100,
  records = [],
) {
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
  const response = await axios.get(url, AXIOS_CONFIG);
  if (response.data.result_info.total_pages > page) {
    const recs = records.concat(response.data.result);
    return listDNSRecords(name, content, type, page + 1, perPage, recs);
  }
  const r = records.concat(response.data.result);
  return r;
}

module.exports = {
  listDNSRecords,
  deleteDNSRecord,
  createDNSRecord,
};

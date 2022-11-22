/* eslint-disable camelcase */
/* eslint-disable no-restricted-syntax */
const axios = require('axios');
const qs = require('qs');
const config = require('config');

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

async function removeObsoleteRecords() {
  const dnsRecords = await listDNSRecords();
  // delete bad
  for (const record of dnsRecords) { // async inside
    // console.log(record);
    if (record.name.split('.')[4]) {
      // eslint-disable-next-line no-await-in-loop
      await deleteDNSRecord(record.id); // may throw
      console.info(`Record ${record.name} on ${record.content} deleted`);
    }
  }
}

removeObsoleteRecords();

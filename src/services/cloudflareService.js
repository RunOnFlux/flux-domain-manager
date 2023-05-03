/* eslint-disable camelcase */
const config = require('config');
const axios = require('axios');
const qs = require('qs');

const log = require('../lib/log');

const cloudflareZone = config.cloudflare.zone;

const cloudFlareAxiosConfig = {
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${config.cloudflare.apiKey}`,
  },
};

const url = `https://api.cloudflare.com/client/v4/zones/${cloudflareZone}/custom_hostnames`;

// use listCustomHostnames with hostname to get id -> use other methods to manage

// https://developers.cloudflare.com/api/operations/custom-hostname-for-a-zone-list-custom-hostnames
// desc, asc| ssl, ssl_status| num| 5-50
async function listCustomHostnames(hostname, id, direction = 'desc', order = 'ssl', page = 1, per_page = 50, ssl = 0) {
  try {
    const query = {
      hostname,
      id,
      direction,
      order,
      page,
      per_page,
      ssl,
    };
    const queryString = qs.stringify(query);
    const urlAdj = `${url}?${queryString}`;
    const response = await axios.get(urlAdj, cloudFlareAxiosConfig);
    return response.data;
  } catch (error) {
    log.error(error);
    throw error;
  }
}

async function deleteCustomHostname(hostname) {
  try {
    // first get id information about our hostname
    const custHostname = await listCustomHostnames(hostname);
    const { id } = custHostname.result[0];
    const response = await axios.delete(`${url}/${id}`, cloudFlareAxiosConfig);
    return response.data;
  } catch (error) {
    log.error(error);
    throw error;
  }
}

async function patchCustomHostname(hostname, custom_origin_server) {
  try {
    // first get id information about our hostname
    const custHostname = await listCustomHostnames(hostname);
    const { id } = custHostname.result[0];
    const data = {
      hostname,
      custom_origin_server,
      ssl: {
        bundle_method: 'ubiquitous',
        certificate_authority: 'google', // google, digicert, lets_encrypt
        method: 'http',
        settings: {
          ciphers: [
            'ECDHE-RSA-AES128-GCM-SHA256',
            'AES128-SHA',
          ],
          early_hints: 'on',
          http2: 'on',
          min_tls_version: '1.2',
          tls_1_3: 'on',
        },
        type: 'dv',
        wildcard: false,
      },
    };
    const response = await axios.patch(`${url}/${id}`, data, cloudFlareAxiosConfig);
    return response.data;
  } catch (error) {
    log.error(error);
    throw error;
  }
}

async function createCustomHostname(hostname, custom_origin_server) {
  try {
    const data = {
      hostname,
      custom_origin_server,
      ssl: {
        bundle_method: 'ubiquitous',
        certificate_authority: 'google', // google, digicert, lets_encrypt
        method: 'http',
        settings: {
          ciphers: [
            'ECDHE-RSA-AES128-GCM-SHA256',
            'AES128-SHA',
          ],
          early_hints: 'on',
          http2: 'on',
          min_tls_version: '1.2',
          tls_1_3: 'on',
        },
        type: 'dv',
        wildcard: false,
      },
    };
    const response = await axios.post(url, data, cloudFlareAxiosConfig);
    // ownership_verification_http: { // response.data.result.ownership_verification_http is important that goes to our db
    //   http_url: 'http://example.nice.com/.well-known/cf-custom-hostname-challenge/ddc3edc7-e421-4298-990f-e287f5b7d0da',
    //   http_body: '6e331a0c-9a7b-4d02-b0f0-839d5ee8ab94'
    // },
    return response.data;
  } catch (error) {
    log.error(error);
    throw error;
  }
}

// unused
async function getCustomHostname(id) {
  try {
    const response = await axios.get(`${url}/${id}`, cloudFlareAxiosConfig);
    return response.data;
  } catch (error) {
    log.error(error);
    throw error;
  }
}

module.exports = {
  listCustomHostnames,
  getCustomHostname,
  deleteCustomHostname,
  patchCustomHostname,
  createCustomHostname,
};

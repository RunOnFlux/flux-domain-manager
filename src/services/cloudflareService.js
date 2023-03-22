const config = require('config');
const axios = require('axios');

const cloudflareZone = config.cloudflare.zone;

const cloudFlareAxiosConfig = {
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${config.cloudflare.apiKey}`,
  },
};

const url = `https://api.cloudflare.com/client/v4/zones/${cloudflareZone}/custom_hostnames`;

// https://developers.cloudflare.com/api/operations/custom-hostname-for-a-zone-list-custom-hostnames
async function listCustomHostnames() {
  const response = await axios.get(url, cloudFlareAxiosConfig);
  return response;
}

async function getCustomHostname(id) {
  const response = await axios.get(`${url}/${id}`, cloudFlareAxiosConfig);
  return response;
}

async function deleteCustomHostname(id) {
  const response = await axios.delete(`${url}/${id}`, cloudFlareAxiosConfig);
  return response;
}

async function patchCustomHostname(id, data) {
  const response = await axios.patch(`${url}/${id}`, data, cloudFlareAxiosConfig);
  return response;
}

async function createCustomHostname(data) {
  const response = await axios.post(url, data, cloudFlareAxiosConfig);
  return response;
}

module.exports = {
  listCustomHostnames,
  getCustomHostname,
  deleteCustomHostname,
  patchCustomHostname,
  createCustomHostname,
};

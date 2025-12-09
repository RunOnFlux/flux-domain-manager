const axios = require('axios');
const https = require('https');
const fs = require('fs');
const config = require('config');
const log = require('../../lib/log');

// DNS Gateway client configuration with mTLS authentication
const dnsGatewayConfig = {
  baseURL: config.dnsGateway.endpoint,
  timeout: config.dnsGateway.timeout,
  httpsAgent: new https.Agent({
    cert: fs.readFileSync(config.dnsGateway.certPath),
    key: fs.readFileSync(config.dnsGateway.keyPath),
    ca: fs.readFileSync(config.dnsGateway.caPath),
    rejectUnauthorized: true,
  }),
};

const dnsGatewayClient = axios.create(dnsGatewayConfig);

/**
 * Create or update DNS A records for a game app
 * Creates multiple A records (one for each IP) for round-robin DNS load balancing
 *
 * @param {string} appName - Just the app name (e.g., 'minecraft-abc123')
 * @param {string[]} serverIPs - Array of all server IPs for this game
 * @param {string} zone - DNS zone (default: from config.appSubDomain + config.mainDomain)
 * @returns {Promise<object>} DNS Gateway response
 */
async function createGameDNSRecords(appName, serverIPs, zone = null) {
  if (!serverIPs || serverIPs.length === 0) {
    throw new Error('No server IPs provided for DNS records');
  }

  // Default zone from config
  const dnsZone = zone || `${config.appSubDomain}.${config.mainDomain}`;

  // Clean IPs - remove port numbers and brackets
  const cleanIPs = serverIPs.map((ip) => {
    const cleanIP = ip.split(':')[0]; // Remove port
    return cleanIP.replace(/\[|\]/g, ''); // Remove IPv6 brackets
  });

  try {
    const response = await dnsGatewayClient.post(`/api/v1/zones/${dnsZone}/records`, {
      name: appName,
      record_type: 'A',
      content: cleanIPs,
      ttl: 300,
    });

    log.info(`Created DNS records for ${appName}.${dnsZone} -> [${cleanIPs.join(', ')}]`);
    return response.data;
  } catch (error) {
    log.error(`Failed to create DNS records for ${appName}: ${error.message}`);
    if (error.response) {
      log.error(`DNS Gateway response: ${JSON.stringify(error.response.data)}`);
    }
    throw error;
  }
}

/**
 * Delete DNS A records for a game app
 *
 * @param {string} appName - Just the app name
 * @param {string} zone - DNS zone
 * @returns {Promise<void>}
 */
async function deleteGameDNSRecords(appName, zone = null) {
  const dnsZone = zone || `${config.appSubDomain}.${config.mainDomain}`;

  try {
    await dnsGatewayClient.delete(`/api/v1/zones/${dnsZone}/records/${appName}/A`);
    log.info(`Deleted DNS records for ${appName}.${dnsZone}`);
  } catch (error) {
    if (error.response && error.response.status === 404) {
      log.info(`DNS records for ${appName}.${dnsZone} not found (already deleted)`);
      return;
    }
    log.error(`Failed to delete DNS records for ${appName}: ${error.message}`);
    throw error;
  }
}

/**
 * Get DNS A records for a game app
 *
 * @param {string} appName - Just the app name
 * @param {string} zone - DNS zone
 * @returns {Promise<object|null>} DNS record data or null if not found
 */
async function getGameDNSRecords(appName, zone = null) {
  const dnsZone = zone || `${config.appSubDomain}.${config.mainDomain}`;

  try {
    const response = await dnsGatewayClient.get(`/api/v1/zones/${dnsZone}/records/${appName}/A`);
    return response.data;
  } catch (error) {
    if (error.response && error.response.status === 404) {
      return null;
    }
    log.error(`Failed to get DNS records for ${appName}: ${error.message}`);
    throw error;
  }
}

module.exports = {
  createGameDNSRecords,
  deleteGameDNSRecords,
  getGameDNSRecords,
};

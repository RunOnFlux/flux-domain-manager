const ini = require('ini');
const fs = require('fs');
const path = require('path');

const RSYNC_CONFIG_PATH = process.env.RSYNC_CONFIG_PATH
  || path.resolve(__dirname, '../../../deployment/rsync_config.json');
const HOSTS_INI_PATH = process.env.HOSTS_INI_PATH
  || path.resolve(__dirname, '../../../deployment/hosts.ini');

const rsyncConfig = JSON.parse(fs.readFileSync(RSYNC_CONFIG_PATH, 'utf-8'));
const hosts = ini.parse(fs.readFileSync(HOSTS_INI_PATH, 'utf-8'));

function parseHostConfig(value) {
  return value.split(' ').reduce((acc, item) => {
    const [key, val] = item.split('=');
    if (key && val) {
      acc[key] = val;
    }
    return acc;
  }, {});
}

function getHostsToRsync() {
  const { host, type } = rsyncConfig;
  const number = host.charAt(6);
  const rsyncHosts = Object.keys(hosts[type]).filter((k) => !k.includes(host) && k.charAt(6) === number);

  return rsyncHosts.map((rh) => {
    const hostConfig = parseHostConfig(hosts[type][rh]);
    return hostConfig.rsyncIP || hostConfig.ansible_host;
  });
}

function getPrimaryIP() {
  const { type } = rsyncConfig;
  const number = rsyncConfig.host.charAt(6);

  // Find the EU (fn) host in the same group
  const primaryHostKey = Object.keys(hosts[type]).find(
    (k) => k.charAt(6) === number && k.includes('_fn'),
  );

  if (!primaryHostKey) {
    return null;
  }

  const hostConfig = parseHostConfig(hosts[type][primaryHostKey]);
  return hostConfig.rsyncIP || hostConfig.ansible_host;
}

module.exports = {
  getHostsToRsync,
  getPrimaryIP,
  parseHostConfig,
};

const ini = require('ini');
const fs = require('fs');
const path = require('path');

function getHostsToRsync() {
  // file generated by ansible
  // eslint-disable-next-line global-require, import/no-unresolved
  const rsyncConfig = require('../../../deployment/rsync_config');

  const hosts = ini.parse(fs.readFileSync(path.resolve(__dirname, '../../../deployment/hosts.ini'), 'utf-8'));

  const { host, type } = rsyncConfig;
  const number = host.charAt(6);
  const rsyncHosts = Object.keys(hosts[type]).filter((k) => !k.includes(host) && k.charAt(6) === number);
  return rsyncHosts.map((rh) => {
    const value = hosts[type][rh];
    return value.substring(0, value.indexOf(' '));
  });
}

module.exports = {
  getHostsToRsync,
};
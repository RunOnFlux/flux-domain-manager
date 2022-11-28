const nodecmd = require('node-cmd');
const util = require('util');

const cmdAsync = util.promisify(nodecmd.run);

const DOMAIN_TYPE = {
  FDM: 'FDM',
  CUSTOM: 'CUSTOM',
};

const TEMP_HAPROXY_CONFIG = '/tmp/haproxytemp.cfg';
const HAPROXY_CONFIG = '/etc/haproxy/haproxy.cfg';

const MANDATORY_APPS = ['explorer', 'KDLaunch', 'website', 'Kadena3', 'Kadena4', 'HavenNodeMainnet'];

module.exports = {
  DOMAIN_TYPE,
  cmdAsync,
  TEMP_HAPROXY_CONFIG,
  HAPROXY_CONFIG,
  MANDATORY_APPS,
};

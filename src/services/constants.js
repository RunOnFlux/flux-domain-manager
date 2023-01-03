const nodecmd = require('node-cmd');
const util = require('util');

const cmdAsync = util.promisify(nodecmd.run);

const DOMAIN_TYPE = {
  FDM: 'FDM',
  CUSTOM: 'CUSTOM',
};

const SUBSET_TYPE = {
  BUCKET: 'BUCKET',
  APPLICATION: 'APPLICATION',
};

const TEMP_HAPROXY_CONFIG = '/tmp/haproxytemp.cfg';
const HAPROXY_CONFIG = '/etc/haproxy/haproxy.cfg';

module.exports = {
  DOMAIN_TYPE,
  cmdAsync,
  TEMP_HAPROXY_CONFIG,
  HAPROXY_CONFIG,
  SUBSET_TYPE,
};

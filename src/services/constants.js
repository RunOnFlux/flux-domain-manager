const nodecmd = require('node-cmd');
const util = require('util');

const cmdAsync = util.promisify(nodecmd.run);

const TEMP_HAPROXY_CONFIG = '/tmp/haproxytemp.cfg';
const HAPROXY_CONFIG = '/etc/haproxy/haproxy.cfg';

module.exports = {
  cmdAsync,
  TEMP_HAPROXY_CONFIG,
  HAPROXY_CONFIG,
};

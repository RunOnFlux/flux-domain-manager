const nodecmd = require('node-cmd');
const util = require('util');

const cmdAsync = util.promisify(nodecmd.run);

const DOMAIN_TYPE = {
  FDM: 'FDM',
  CUSTOM: 'CUSTOM',
};

module.exports = {
  DOMAIN_TYPE,
  cmdAsync,
};

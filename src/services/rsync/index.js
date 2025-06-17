const cmd = require('node-cmd');
const util = require('util');
const { getHostsToRsync } = require('./config');
const log = require('../../lib/log');

const cmdAsync = util.promisify(cmd.run);

async function startCertRsync() {
  log.info('starting rsync');
  const ips = getHostsToRsync();
  log.info(`Rsyncing to ${ips}`);
  try {
    // eslint-disable-next-line no-restricted-syntax
    for (const ip of ips) {
      // eslint-disable-next-line no-await-in-loop
      await cmdAsync(`rsync -au -e "ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null" /etc/ssl/fluxapps/ ${ip}:/etc/ssl/fluxapps/`);
      log.info(`Certs sent to ${ip}`);
    }
  } catch (error) {
    log.info(error);
  }
}

module.exports = {
  startCertRsync,
};

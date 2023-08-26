const cmd = require('node-cmd');
const util = require('util');
const { getHostsToRsync } = require('./config');

const cmdAsync = util.promisify(cmd.run);

async function startCertRsync() {
  console.log('starting r sync');
  const ips = getHostsToRsync();
  try {
    // eslint-disable-next-line no-restricted-syntax
    for (const ip of ips) {
      // eslint-disable-next-line no-await-in-loop
      await cmdAsync(`rsync -avh -e "ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null" --progress /etc/ssl/fluxapps/ ${ip}:/etc/ssl/fluxapps/`);
      console.log(`Certs sent to ${ip}`);
    }
  } catch (error) {
    console.log(error);
  }
}

module.exports = {
  startCertRsync,
};

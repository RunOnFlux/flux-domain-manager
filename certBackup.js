const cmd = require('node-cmd');
const util = require('util');

const cmdAsync = util.promisify(cmd.run);

const ips = [

];

setInterval(async () => {
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
}, 5 * 60 * 1000); // every 5 minutes

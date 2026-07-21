const httpClients = require('./httpClients');

let myIP = null;
let refreshTimer = null;

function getSingleIP(url) {
  return httpClients.ipLookup.get(url)
    .then((response) => response.data)
    .catch(() => null);
}

async function getMyIP() {
  const results = await Promise.all([
    getSingleIP('https://ifconfig.me'),
    getSingleIP('https://api.ipify.org'),
    getSingleIP('https://ipv4bot.whatismyipaddress.com'),
    getSingleIP('https://api4.my-ip.io/ip'),
  ]);
  const ipvTest = /^((25[0-5]|(2[0-4]|1[0-9]|[1-9]|)[0-9])(.(?!$)|$)){4}$/;
  const ips = results.filter((res) => ipvTest.test(res));
  [myIP] = ips;
}

function localIP() {
  return myIP;
}

// Begin resolving this node's public IP and refreshing it periodically. Importing
// this module makes no network calls; the boot sequence calls this once. Idempotent,
// and the refresh timer is unref'd so it never holds the process open on its own.
function start() {
  if (refreshTimer) return;
  getMyIP();
  refreshTimer = setInterval(getMyIP, 120 * 1000);
  refreshTimer.unref();
}

module.exports = {
  localIP,
  start,
};

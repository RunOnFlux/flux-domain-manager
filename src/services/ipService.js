const axios = require('axios');

let myIP = null;

const axiosConfig = {
  timeout: 13456,
};

function getSingleIP(url) {
  return axios.get(url, axiosConfig)
    .then((response) => response.data)
    .catch(() => null);
}

async function getMyIP() {
  return Promise.all([
    getSingleIP('https://ifconfig.me'),
    getSingleIP('https://api.ipify.org'),
    getSingleIP('https://ipv4bot.whatismyipaddress.com'),
    getSingleIP('https://api4.my-ip.io/ip'),
  ]).then((results) => {
    const ips = [];
    const ipvTest = new RegExp('^((25[0-5]|(2[0-4]|1[0-9]|[1-9]|)[0-9])(.(?!$)|$)){4}$');
    results.forEach((res) => {
      if (ipvTest.test(res)) {
        ips.push(res);
      }
    });
    // eslint-disable-next-line prefer-destructuring
    myIP = ips[0];
  });
}

function localIP() {
  return myIP;
}

getMyIP();
setInterval(() => {
  getMyIP();
}, 120 * 1000);

module.exports = {
  localIP,
};

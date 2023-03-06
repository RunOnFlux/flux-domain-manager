const dns = require('dns').promises;

async function dnsLookup(hostname) {
  const timeoutPromise = new Promise((resolve) => {
    setTimeout(resolve, 2000, []);
  });
  const dnsPromise = dns.lookup(hostname, { all: true }).catch((error) => console.log(error)); // eg. [ { address: '65.21.189.1', family: 4 } ]
  const result = await Promise.race([dnsPromise, timeoutPromise]);
  return result || [];
}

async function test() {
  try {
    const resp = await dnsLookup('www.astro-fun.com');
    console.log(resp);
  } catch (error) {
    console.log(error);
  }
}

test();

async function selectIPforG(ips, app) {
  // choose the ip address whose sum of digits is the lowest
  if (ips && ips.length) {
    let chosenIp = ips[0];
    let chosenIpSum = ips[0].split(':')[0].split('.').reduce((a, b) => parseInt(a, 10) + parseInt(b, 10), 0);
    for (const ip of ips) {
      const sum = ip.split(':')[0].split('.').reduce((a, b) => parseInt(a, 10) + parseInt(b, 10), 0);
      if (sum < chosenIpSum) {
        chosenIp = ip;
        chosenIpSum = sum;
      }
    }
    const isOk = false;
    if (isOk) {
      return chosenIp;
    }
    console.log(ips);
    const newIps = ips.filter((ip) => ip !== chosenIp);
    if (newIps.length) {
      return selectIPforG(newIps, app);
    }
  }
  return null;
}

async function test() {
const b = await selectIPforG(['123.234','2345.342','456.34234','342.434'], 'test');
console.log(b);
}

test();

const recentlyConfiguredApps = [{
  appName: 'test1',
  ips: ['1'],
},
{
  appName: 'test2',
  ips: ['1'],
},
{
  appName: 'test',
  ips: ['1'],
},
{
  appName: 'test3',
  ips: ['1'],
}];
let configuredApps = [{
  appName: 'test',
  ips: ['2'],
},
{
  appName: 'test3',
  ips: ['2'],
}];
const updatingConfig = JSON.parse(JSON.stringify(recentlyConfiguredApps));
// merge recentlyConfiguredApps with currently configuredApps
for (const app of configuredApps) {
  let appExists = updatingConfig.find((a) => a.appName === app.appName);
  if (!appExists) {
    updatingConfig.push(app);
  } else {
    updatingConfig.splice(updatingConfig.indexOf(appExists), 1, app);
    // console.log(app);
   // appExists = app; // this is also updating element in updatingConfig
  }
}
console.log(updatingConfig);
configuredApps = updatingConfig;

console.log(configuredApps);
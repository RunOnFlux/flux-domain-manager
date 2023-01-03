const { getBucket, getApplicationsToProcess } = require('../src/services/application/subset');
const fluxService = require('../src/services/flux');
const domainService = require('../src/services/domain');
const { getHAProxyConfig } = require('./haproxy');
const haproxyTemplate = require('../src/services/haproxyTemplate');

async function generateFDMProxy() {
  let applicationSpecifications = await fluxService.getAppSpecifications();
  applicationSpecifications = getApplicationsToProcess(applicationSpecifications, null);
  let acls = '';
  let usebackends = '';

  // eslint-disable-next-line
  for (const app of applicationSpecifications) {
    const bucket = getBucket(app.name);
    const unifiedDomains = domainService.getUnifiedDomains(app);
    const customDomains = domainService.getCustomDomains(app);
    // eslint-disable-next-line
    for (const domain of unifiedDomains) {
      const aclName = domain.split('.').join('');
      acls += `  acl ${aclName} hdr(host) ${domain}\n`;
      usebackends += `  use_backend ${bucket}_backend if ${aclName}\n`;
    }
    // eslint-disable-next-line
     for (const domain of customDomains) {
      const aclName = domain.split('.').join('');
      acls += `  acl ${aclName} hdr(host) ${domain}\n`;
      usebackends += `  use_backend ${bucket}_backend if ${aclName}\n`;
    }
  }

  const haproxyConfig = getHAProxyConfig(acls, usebackends);
  const dataToWrite = haproxyConfig;
  // test haproxy config
  const successRestart = await haproxyTemplate.restartProxy(dataToWrite);
  if (!successRestart) {
    throw new Error('Invalid HAPROXY Config File!');
  }
}

(async () => {
  await generateFDMProxy();
})();

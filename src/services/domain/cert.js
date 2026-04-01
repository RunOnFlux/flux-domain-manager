/* eslint-disable no-restricted-syntax */
const config = require('config');
const dns = require('dns').promises;
const fs = require('fs').promises;
const fsSync = require('fs');
const { DOMAIN_TYPE, cmdAsync } = require('../constants');
const log = require('../../lib/log');
const serviceHelper = require('../serviceHelper');
const {
  listDNSRecords, deleteDNSRecordCloudflare, deleteDNSRecordPDNS, createDNSRecord,
} = require('./dns');
const dnsCache = require('./dnsCache');

const CERT_DIR = `/etc/ssl/${config.certFolder}`;
const LETSENCRYPT_LIVE_DIR = '/etc/letsencrypt/live';
const CONCURRENCY_LIMIT = 20;

async function checkCertificatePresetForDomain(domain) {
  try {
    if (domain.endsWith(`${config.appSubDomain}.${config.mainDomain}`) || domain.endsWith('app.runonflux.io') || domain.endsWith('app2.runonflux.io')) {
      return true;
    }
    const path = `${CERT_DIR}/${domain}.pem`;
    const pathB = `${LETSENCRYPT_LIVE_DIR}/${domain}/fullchain.pem`;
    await fs.access(path); // only check if file exists. Does not check permissions
    await fs.access(pathB); // only check if file exists. Does not check permissions
    const fileSize = fsSync.statSync(path).size;
    const fileSizeB = fsSync.statSync(pathB).size;
    if (fileSize > 128 && fileSizeB > 10) { // it can be an empty file.
      return true;
    }
    return false;
  } catch (error) {
    return false;
  }
}

async function obtainDomainCertificate(domain) { // let it throw
  const cmdToExec = `sudo certbot certonly --standalone -d ${domain} --non-interactive --agree-tos --email ${config.emailDomain} --http-01-port=8787`;
  const cmdToExecContinue = `sudo cat ${LETSENCRYPT_LIVE_DIR}/${domain}/fullchain.pem ${LETSENCRYPT_LIVE_DIR}/${domain}/privkey.pem | sudo tee ${CERT_DIR}/${domain}.pem`;
  const response = await cmdAsync(cmdToExec);
  if (response.includes('Congratulations') || response.includes('Certificate not yet due for renewal')) {
    await cmdAsync(cmdToExecContinue);
  }
}

async function adjustAutoRenewalScriptForDomain(domain) { // let it throw
  const path = '/opt/update-certs.sh';
  const header = `#!/usr/bin/env bash
# Renew the certificate
certbot renew --force-renewal --http-01-port=8787 --preferred-challenges http
# Concatenate new cert files, with less output (avoiding the use tee and its output to stdout)\n`;
  try {
    await fs.readFile(path);
    const autoRenewScript = await fs.readFile(path, { encoding: 'utf-8' });
    // split the contents by new line
    const lines = autoRenewScript.split(/\r?\n/);
    if (!autoRenewScript.startsWith(header)) {
      lines.splice(0, 0, header);
      await fs.writeFile(path, lines.join('\n'), {
        mode: 0o755,
        flag: 'w',
        encoding: 'utf-8',
      });
    }

    const cert = `bash -c "cat ${LETSENCRYPT_LIVE_DIR}/${domain}/fullchain.pem ${LETSENCRYPT_LIVE_DIR}/${domain}/privkey.pem > ${CERT_DIR}/${domain}.pem"`;
    if (autoRenewScript.includes(cert)) {
      return;
    }

    lines.splice(6, 0, cert); // push cert to top behind #Concatenate...
    const file = lines.join('\n');
    await fs.writeFile(path, file, {
      mode: 0o755,
      flag: 'w',
      encoding: 'utf-8',
    });
  } catch (error) {
    const cert = `bash -c "cat ${LETSENCRYPT_LIVE_DIR}/${domain}/fullchain.pem ${LETSENCRYPT_LIVE_DIR}/${domain}/privkey.pem > ${CERT_DIR}/${domain}.pem"\n`;
    const file = header + cert;
    await fs.writeFile(path, file, {
      mode: 0o755,
      flag: 'w',
      encoding: 'utf-8',
    });
  }
}

async function runWithConcurrency(tasks, limit) {
  const results = [];
  const executing = new Set();
  for (const task of tasks) {
    const p = task().then((r) => { executing.delete(p); return r; });
    executing.add(p);
    results.push(p);
    if (executing.size >= limit) {
      // eslint-disable-next-line no-await-in-loop
      await Promise.race(executing);
    }
  }
  return Promise.allSettled(results);
}

async function getCertDaysRemaining(domain) {
  try {
    const pemPath = `${CERT_DIR}/${domain}.pem`;
    await fs.access(pemPath);
    const result = await cmdAsync(
      `openssl x509 -enddate -noout -in ${pemPath}`,
    );
    const match = result.match(/notAfter=(.+)/);
    if (!match) return null;
    const expiryDate = new Date(match[1].trim());
    const now = new Date();
    return (expiryDate - now) / (1000 * 60 * 60 * 24);
  } catch (error) {
    return null;
  }
}

async function isCertificateExpiringSoon(domain, thresholdDays = 30) {
  try {
    const pemPath = `${CERT_DIR}/${domain}.pem`;
    await fs.access(pemPath);
    const result = await cmdAsync(
      `openssl x509 -enddate -noout -in ${pemPath}`,
    );
    // result looks like: "notAfter=Mar 15 12:00:00 2026 GMT\n"
    const match = result.match(/notAfter=(.+)/);
    if (!match) return true; // can't parse, treat as expiring
    const expiryDate = new Date(match[1].trim());
    const now = new Date();
    const daysRemaining = (expiryDate - now) / (1000 * 60 * 60 * 24);
    return daysRemaining < thresholdDays;
  } catch (error) {
    log.warn(`Cannot check expiry for ${domain}: ${error.message}`);
    return false; // if cert doesn't exist, obtainDomainCertificate handles it
  }
}

// return array of IPs to which a hostname is pointeed
async function dnsLookup(hostname) {
  const timeoutPromise = new Promise((resolve) => {
    setTimeout(resolve, 2000, []);
  });
  const dnsPromise = dns.lookup(hostname, { all: true }).catch((error) => console.log(error)); // eg. [ { address: '65.21.189.1', family: 4 } ]
  const result = await Promise.race([dnsPromise, timeoutPromise]);
  return result || [];
}

async function isDomainPointedToThisGroup(hostname, FDMnameOrIP, myIP) {
  try {
    if (!FDMnameOrIP) {
      return false;
    }
    const { getGroupIPs } = require('../rsync/config');
    const groupIPs = new Set(getGroupIPs());
    groupIPs.add(FDMnameOrIP);
    if (myIP) groupIPs.add(myIP);

    const dnsLookupdRecords = await dnsLookup(hostname);
    const pointedToGroup = dnsLookupdRecords.find((record) => groupIPs.has(record.address));
    return !!pointedToGroup;
  } catch (error) {
    log.warn(error);
    return false;
  }
}

// return true if some domain operation was done
// return false if no domain operation was done
async function checkAndAdjustDNSrecordForDomain(domain, myFDMnameORip) {
  try {
    const dnsRecords = await listDNSRecords(domain);
    // delete bad
    for (const record of dnsRecords) { // async inside
      let adjustedRecord = record.content;
      if (adjustedRecord && config.pDNS.enabled) {
        adjustedRecord = adjustedRecord.slice(0, -1);
      }
      if (myFDMnameORip && typeof myFDMnameORip === 'string' && record.content && (adjustedRecord !== myFDMnameORip || record.proxied === true)) {
        // delete the record
        if (config.cloudflare.enabled) {
          // eslint-disable-next-line no-await-in-loop
          await deleteDNSRecordCloudflare(record); // may throw
          log.info(`Record ${record.id} of ${record.name} on ${record.content} deleted`);
        } else if (config.pDNS.enabled) {
          // eslint-disable-next-line no-await-in-loop
          await deleteDNSRecordPDNS(record.name, record.content, record.type, record.ttl); // may throw
          log.info(`Record ${record.name} on ${record.content} deleted`);
        }
      }
    }
    const correctRecords = dnsRecords.filter((record) => ((record.content === myFDMnameORip || (record.content && record.content.slice(0, -1) === myFDMnameORip)) && (record.proxied === undefined || record.proxied === false)));
    if (correctRecords.length === 0) {
      await createDNSRecord(domain, myFDMnameORip, config.domainAppType);
      return true;
    }
    if (correctRecords.length > 1) {
      // delete all except the first one
      correctRecords.shift(); // remove first record from records to delete
      for (const record of correctRecords) { // async inside
        // delete the record
        if (config.cloudflare.enabled) {
          // eslint-disable-next-line no-await-in-loop
          await deleteDNSRecordCloudflare(record); // may throw
          log.info(`Duplicate Record ${record.id} of ${record.name} on ${record.content} deleted`);
        } else if (config.pDNS.enabled) {
          // eslint-disable-next-line no-await-in-loop
          await deleteDNSRecordPDNS(record.name, record.content, record.type, record.ttl); // may throw
          log.info(`Duplicate Record ${record.name} on ${record.content} deleted`);
        }
      }
      return true;
    }
    // only one record exists and is correct
    log.info(`Record for domain ${domain} is set correctly`);
    return false;
  } catch (error) {
    log.error(error);
    return true;
  }
}

// Phase 1: Parallel check to determine what action each domain needs
async function checkDomainAction(appDomain, type, fdmOrIP, myIP) {
  try {
    if (appDomain === 'ethereumnodelight.app.runonflux.io') return { domain: appDomain, action: 'skip' };
    if (appDomain.length > 64) return { domain: appDomain, action: 'skip', reason: 'too long' };

    const isAutomated = type === DOMAIN_TYPE.CUSTOM ? config.automateCertificates : config.automateCertificatesForFDMdomains;
    if (!isAutomated && !config.manageCertificateOnly) return { domain: appDomain, action: 'skip' };

    const isCertificatePresent = await checkCertificatePresetForDomain(appDomain);

    if (!isCertificatePresent) {
      // No cert — check DNS (with cache)
      if (!dnsCache.shouldCheckDomain(appDomain)) {
        return { domain: appDomain, action: 'skip', reason: 'dns backoff' };
      }
      const domainIsPointedCorrectly = await isDomainPointedToThisGroup(appDomain, fdmOrIP, myIP);
      if (!domainIsPointedCorrectly) {
        dnsCache.recordFailure(appDomain);
        return { domain: appDomain, action: 'skip', reason: 'dns not pointed' };
      }
      dnsCache.recordSuccess(appDomain);
      return { domain: appDomain, action: 'obtain' };
    }

    // Cert exists — check if renewal needed (expired or expiring within 30 days)
    const daysRemaining = await getCertDaysRemaining(appDomain);
    if (daysRemaining !== null && daysRemaining < 30) {
      return { domain: appDomain, action: 'renew', daysRemaining: Math.round(daysRemaining) };
    }
    return { domain: appDomain, action: 'skip' };
  } catch (error) {
    log.warn(`Error checking ${appDomain}: ${error.message}`);
    return { domain: appDomain, action: 'skip' };
  }
}

async function executeCertificateOperations(domains, type, fdmOrIP, myIP) {
  try {
    // Phase 1: DNS adjustments (sequential, only for FDM type)
    if (type === DOMAIN_TYPE.FDM && config.adjustFDMdomains) {
      for (const appDomain of domains) {
        // eslint-disable-next-line no-await-in-loop
        const wasDomainAdjusted = await checkAndAdjustDNSrecordForDomain(appDomain, fdmOrIP);
        if (wasDomainAdjusted) {
          log.info(`Domain ${appDomain} was adjusted on DNS`);
          // eslint-disable-next-line no-await-in-loop
          await serviceHelper.timeout(1 * 1000);
        }
      }
    }

    // Phase 2: Parallel checks to determine actions
    const checkTasks = domains.map(
      (domain) => () => checkDomainAction(domain, type, fdmOrIP, myIP),
    );
    const results = await runWithConcurrency(checkTasks, CONCURRENCY_LIMIT);

    const actions = results
      .filter((r) => r.status === 'fulfilled')
      .map((r) => r.value);

    // Phase 3: Sequential certbot calls for domains that need certs
    for (const result of actions) {
      try {
        if (result.action === 'obtain') {
          log.info(`Obtaining certificate for ${result.domain}`);
          // eslint-disable-next-line no-await-in-loop
          await obtainDomainCertificate(result.domain);
        } else if (result.action === 'renew') {
          log.info(`Renewing certificate for ${result.domain} (${result.daysRemaining} days remaining)`);
          // eslint-disable-next-line no-await-in-loop
          await obtainDomainCertificate(result.domain);
        }
      } catch (error) {
        log.warn(`Cert operation failed for ${result.domain}: ${error.message}`);
      }
    }

    const obtained = actions.filter((a) => a.action === 'obtain').length;
    const renewed = actions.filter((a) => a.action === 'renew').length;
    const skippedDns = actions.filter((a) => a.reason === 'dns backoff').length;
    const certsChanged = obtained > 0 || renewed > 0;
    if (obtained || renewed || skippedDns) {
      log.info(`Cert ops: ${obtained} obtained, ${renewed} renewed, ${skippedDns} skipped (dns backoff), ${dnsCache.getCacheSize()} cached failures`);
    }

    return { success: true, certsChanged };
  } catch (error) {
    log.error(error);
    return { success: false, certsChanged: false };
  }
}

async function cleanupStaleCerts() {
  try {
    const files = await fs.readdir(CERT_DIR);
    let removed = 0;

    for (const file of files) {
      if (!file.endsWith('.pem')) continue;
      const domain = file.slice(0, -4); // strip .pem

      // eslint-disable-next-line no-await-in-loop
      const daysRemaining = await getCertDaysRemaining(domain);
      if (shouldRemoveStaleCert(daysRemaining)) {
        log.info(`Removing stale cert for ${domain} (expired ${Math.round(-daysRemaining)} days ago)`);
        // eslint-disable-next-line no-await-in-loop
        await fs.unlink(`${CERT_DIR}/${file}`).catch(() => {});
        removed += 1;
      }
    }

    if (removed) {
      log.info(`Cert cleanup: removed ${removed} expired certs`);
    }
    return removed > 0;
  } catch (error) {
    log.warn(`Error cleaning orphaned certs: ${error.message}`);
    return false;
  }
}

function shouldRemoveStaleCert(daysRemaining) {
  if (daysRemaining === null) return false;
  return daysRemaining < -30;
}

module.exports = {
  executeCertificateOperations,
  cleanupStaleCerts,
  shouldRemoveStaleCert,
};

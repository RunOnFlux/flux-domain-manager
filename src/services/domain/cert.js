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

async function checkCertificatePresetForDomain(domain) {
  try {
    const path = `/etc/ssl/fluxapps/${domain}.pem`;
    await fs.access(path); // only check if file exists. Does not check permissions
    const fileSize = fsSync.statSync(path).size;
    if (fileSize > 128) { // it can be an empty file.
      return true;
    }
    return false;
  } catch (error) {
    return false;
  }
}

async function obtainDomainCertificate(domain) { // let it throw
  const cmdToExec = `sudo certbot certonly --standalone -d ${domain} --non-interactive --agree-tos --email ${config.emailDomain} --http-01-port=8787`;
  const cmdToExecContinue = `sudo cat /etc/letsencrypt/live/${domain}/fullchain.pem /etc/letsencrypt/live/${domain}/privkey.pem | sudo tee /etc/ssl/${config.certFolder}/${domain}.pem`;
  const response = await cmdAsync(cmdToExec);
  if (response.includes('Congratulations') || response.includes('Certificate not yet due for renewal')) {
    await cmdAsync(cmdToExecContinue);
  }
}

async function adjustAutoRenewalScriptForDomain(domain) { // let it throw
  const path = '/opt/update-certs.sh';
  try {
    await fs.readFile(path);
    const autoRenewScript = await fs.readFile(path, { encoding: 'utf-8' });
    const cert = `bash -c "cat /etc/letsencrypt/live/${domain}/fullchain.pem /etc/letsencrypt/live/${domain}/privkey.pem > /etc/ssl/${config.certFolder}/${domain}.pem"`;
    if (autoRenewScript.includes(cert)) {
      return;
    }
    // split the contents by new line
    const lines = autoRenewScript.split(/\r?\n/);
    lines.splice(6, 0, cert); // push cert to top behind #Concatenate...
    const file = lines.join('\n');
    await fs.writeFile(path, file, {
      mode: 0o755,
      flag: 'w',
      encoding: 'utf-8',
    });
  } catch (error) {
    // probably does not exist
    const beginning = `#!/usr/bin/env bash
# Renew the certificate
certbot renew --force-renewal --http-01-port=8787 --preferred-challenges http
# Concatenate new cert files, with less output (avoiding the use tee and its output to stdout)\n`;
    const ending = `
# Reload  HAProxy
service haproxy reload`;
    const cert = `bash -c "cat /etc/letsencrypt/live/${domain}/fullchain.pem /etc/letsencrypt/live/${domain}/privkey.pem > /etc/ssl/${config.certFolder}/${domain}.pem"\n`;
    const file = beginning + cert + ending;
    await fs.writeFile(path, file, {
      mode: 0o755,
      flag: 'w',
      encoding: 'utf-8',
    });
  }
}

// return array of IPs to which a hostname is pointeed
async function dnsResolve(hostname) {
  const result = await dns.resolveAny(hostname); // eg. [ { address: '65.21.189.1', family: 4 } ]
  return result;
}

async function isDomainPointedToThisFDM(hostname, FDMnameOrIP, myIP) {
  try {
    if (!FDMnameOrIP) {
      return false;
    }
    const dnsLookupdRecords = await dnsResolve(hostname);
    const pointedToMyIp = dnsLookupdRecords.find((record) => (record.address === FDMnameOrIP || record.address === myIP) && record.address);
    if (pointedToMyIp) {
      return true;
    }
    return false;
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

async function executeCertificateOperations(domains, type, fdmOrIP, myIP) {
  try {
    for (const appDomain of domains) {
      if (appDomain === 'ethereumnodelight.app.runonflux.io') { // temporarily disable
        // eslint-disable-next-line no-continue
        continue;
      }
      if (type === DOMAIN_TYPE.FDM && config.adjustFDMdomains) {
        // check DNS
        // if DNS was adjusted for this domain, wait a second
        // eslint-disable-next-line no-await-in-loop
        const wasDomainAdjusted = await checkAndAdjustDNSrecordForDomain(appDomain, fdmOrIP);
        if (wasDomainAdjusted) {
          log.info(`Domain ${appDomain} was adjusted on DNS`);
          // eslint-disable-next-line no-await-in-loop
          await serviceHelper.timeout(1 * 1000);
        }
      }

      const isAutomated = type === DOMAIN_TYPE.CUSTOM ? config.automateCertificates : config.automateCertificatesForFDMdomains;
      if (isAutomated) {
        try {
          // check if we have certificate
          // eslint-disable-next-line no-await-in-loop
          const isCertificatePresent = await checkCertificatePresetForDomain(appDomain);
          if (appDomain.length > 64) {
            log.warn(`Domain ${appDomain} is too long. Certificate not issued`);
            // eslint-disable-next-line no-continue
            continue;
          }
          if (!isCertificatePresent) {
            // eslint-disable-next-line no-await-in-loop
            const domainIsPointedCorrectly = await isDomainPointedToThisFDM(appDomain, fdmOrIP, myIP);
            if (!domainIsPointedCorrectly) {
              throw new Error(`DNS record is not pointed to this FDM for ${appDomain}, cert operations not proceeding`);
            }
            // if we dont have certificate, obtain it
            log.info(`Obtaining certificate for ${appDomain}`);
            // eslint-disable-next-line no-await-in-loop
            await obtainDomainCertificate(appDomain);
          }
          // eslint-disable-next-line no-await-in-loop
          const isCertificatePresentB = await checkCertificatePresetForDomain(appDomain);
          if (isCertificatePresentB) {
            // check if domain has autorenewal, if not, adjust it
            // eslint-disable-next-line no-await-in-loop
            await adjustAutoRenewalScriptForDomain(appDomain);
          } else {
            throw new Error(`Certificate not present for ${appDomain}`);
          }
        } catch (error) {
          log.warn(error);
        }
      }
    }
    return true;
  } catch (error) {
    log.error(error);
    return false;
  }
}

module.exports = {
  executeCertificateOperations,
};

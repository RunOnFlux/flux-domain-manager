/* eslint-disable no-restricted-syntax */
const config = require('config');
const dns = require('dns').promises;
const fs = require('fs').promises;
const fsSync = require('fs');
const { DOMAIN_TYPE, cmdAsync } = require('../constants');
const log = require('../../lib/log');
const serviceHelper = require('../serviceHelper');
const dnsCache = require('./dnsCache');
const { getGroupIPs } = require('../rsync/config');

const CERT_DIR = `/etc/ssl/${config.certFolder}`;
const LETSENCRYPT_LIVE_DIR = '/etc/letsencrypt/live';
const CONCURRENCY_LIMIT = 10;

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

async function obtainDomainCertificate(domain) {
  // cmdAsync rejects on non-zero exit code
  await cmdAsync(`sudo certbot certonly --standalone -d ${domain} --non-interactive --agree-tos --email ${config.emailDomain} --http-01-port=8787`);
  const fullchainPath = `${LETSENCRYPT_LIVE_DIR}/${domain}/fullchain.pem`;
  const privkeyPath = `${LETSENCRYPT_LIVE_DIR}/${domain}/privkey.pem`;
  await fs.access(fullchainPath);
  await fs.access(privkeyPath);
  await cmdAsync(`sudo cat ${fullchainPath} ${privkeyPath} > ${CERT_DIR}/${domain}.pem`);
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

// return array of IPv4 addresses to which a hostname is pointed
// Uses dns.resolve4 (c-ares) instead of dns.lookup (libuv thread pool)
// to avoid thread pool exhaustion under concurrent lookups
async function dnsLookup(hostname) {
  const timeoutPromise = new Promise((resolve) => {
    setTimeout(resolve, 10000, []);
  });
  const dnsPromise = dns.resolve4(hostname).catch(() => []);
  const result = await Promise.race([dnsPromise, timeoutPromise]);
  return (result || []).map((address) => ({ address, family: 4 }));
}

// The addresses this FDM group answers on: its peers, from deployment/hosts.ini, plus
// this node's own. A domain qualifies for a certificate only if it resolves to one of
// them. `resolve` is injectable so tests need no network.
async function isDomainPointedToThisGroup(hostname, myIP, resolve = dnsLookup) {
  try {
    const groupIPs = new Set(getGroupIPs());
    if (myIP) groupIPs.add(myIP);

    const dnsLookupdRecords = await resolve(hostname);
    const pointedToGroup = dnsLookupdRecords.find((record) => groupIPs.has(record.address));
    return !!pointedToGroup;
  } catch (error) {
    log.warn(error);
    return false;
  }
}

// Phase 1: Parallel check to determine what action each domain needs
async function checkDomainAction(appDomain, type, myIP) {
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
      const domainIsPointedCorrectly = await isDomainPointedToThisGroup(appDomain, myIP);
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

async function executeCertificateOperations(domains, type, myIP) {
  try {
    // Phase 1: Parallel checks to determine actions
    const checkTasks = domains.map(
      (domain) => () => checkDomainAction(domain, type, myIP),
    );
    const results = await serviceHelper.runWithConcurrency(checkTasks, CONCURRENCY_LIMIT);

    const actions = results
      .filter((r) => r.status === 'fulfilled')
      .map((r) => r.value);

    // Phase 2: Sequential certbot calls for domains that need certs
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

function shouldRemoveStaleCert(daysRemaining) {
  if (daysRemaining === null) return false;
  return daysRemaining < -30;
}

async function cleanupStaleCerts() {
  try {
    const files = await fs.readdir(CERT_DIR);
    let removed = 0;

    for (const file of files) {
      // eslint-disable-next-line no-continue
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

module.exports = {
  executeCertificateOperations,
  isDomainPointedToThisGroup,
  cleanupStaleCerts,
  shouldRemoveStaleCert,
};

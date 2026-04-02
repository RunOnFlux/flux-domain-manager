#!/usr/bin/env node

/* eslint-disable no-console */

const dns = require('dns').promises;
const fs = require('fs').promises;
const fsSync = require('fs');
const { execSync } = require('child_process');
const config = require('config');
const { getGroupIPs } = require('./src/services/rsync/config');

const CERT_DIR = `/etc/ssl/${config.certFolder}`;
const LETSENCRYPT_LIVE_DIR = '/etc/letsencrypt/live';

const domain = process.argv[2];

if (!domain) {
  console.log('Usage: get-cert <domain>');
  console.log('Example: get-cert tiktokss.com');
  process.exit(1);
}

async function dnsCheck() {
  const groupIPs = new Set(getGroupIPs());
  console.log(`Group IPs: ${[...groupIPs].join(', ')}`);

  try {
    const ips = await dns.resolve4(domain);
    console.log(`DNS resolves to: ${ips.join(', ')}`);
    const match = ips.find((ip) => groupIPs.has(ip));
    if (match) {
      console.log(`DNS pointed to this group (${match})`);
      return true;
    }
    console.log('DNS NOT pointed to this group');
    return false;
  } catch (err) {
    console.log(`DNS lookup failed: ${err.code}`);
    return false;
  }
}

async function checkPem() {
  const pemPath = `${CERT_DIR}/${domain}.pem`;
  try {
    await fs.access(pemPath);
    const size = fsSync.statSync(pemPath).size;
    if (size <= 128) {
      console.log(`PEM exists but is empty/corrupt (${size} bytes)`);
      return { exists: false };
    }
    const result = execSync(`openssl x509 -noout -subject -issuer -enddate -in ${pemPath}`).toString();
    console.log(`PEM: ${pemPath}`);
    console.log(result.trim());

    const match = result.match(/notAfter=(.+)/);
    if (match) {
      const expiry = new Date(match[1].trim());
      const days = Math.round((expiry - new Date()) / (1000 * 60 * 60 * 24));
      console.log(`Days remaining: ${days}`);
      return { exists: true, days };
    }
    return { exists: true, days: null };
  } catch {
    console.log(`PEM not found: ${pemPath}`);
    return { exists: false };
  }
}

function checkLetsencrypt() {
  const lePath = `${LETSENCRYPT_LIVE_DIR}/${domain}`;
  try {
    fsSync.accessSync(lePath);
    console.log(`Letsencrypt dir: ${lePath} (exists)`);
    return true;
  } catch {
    console.log(`Letsencrypt dir: ${lePath} (missing)`);
    return false;
  }
}

function obtainCert() {
  console.log('\nObtaining certificate...');
  try {
    const result = execSync(
      `sudo certbot certonly --standalone -d ${domain} --non-interactive --agree-tos --email ${config.emailDomain} --http-01-port=8787`,
      { timeout: 60000 },
    ).toString();
    console.log(result.trim());
  } catch (err) {
    console.error(`Certbot failed: ${err.stderr ? err.stderr.toString().trim() : err.message}`);
    process.exit(1);
  }

  const fullchainPath = `${LETSENCRYPT_LIVE_DIR}/${domain}/fullchain.pem`;
  const privkeyPath = `${LETSENCRYPT_LIVE_DIR}/${domain}/privkey.pem`;
  try {
    fsSync.accessSync(fullchainPath);
    fsSync.accessSync(privkeyPath);
  } catch {
    console.error('Cert files not found after certbot succeeded');
    process.exit(1);
  }

  const pemPath = `${CERT_DIR}/${domain}.pem`;
  execSync(`cat ${fullchainPath} ${privkeyPath} > ${pemPath}`);
  console.log(`Combined PEM written to ${pemPath}`);
}

(async () => {
  console.log(`\n=== get-cert: ${domain} ===\n`);

  // DNS check
  const dnsOk = await dnsCheck();
  console.log('');

  // PEM check
  const pem = await checkPem();
  console.log('');

  // Letsencrypt check
  const leExists = checkLetsencrypt();
  console.log('');

  // Decision
  if (!dnsOk) {
    console.log('Domain does not point to this group. Cannot obtain cert.');
    process.exit(1);
  }

  if (pem.exists && pem.days > 30) {
    console.log(`Certificate is valid for ${pem.days} more days. No action needed.`);
    process.exit(0);
  }

  if (pem.exists && pem.days !== null && pem.days <= 30) {
    console.log(`Certificate expires in ${pem.days} days. Renewing...`);
    obtainCert();
    console.log('\nCertificate renewed.');
    process.exit(0);
  }

  if (!pem.exists) {
    console.log('No certificate found. Obtaining...');
    obtainCert();
    console.log('\nCertificate obtained.');
    process.exit(0);
  }
})();

/* eslint-disable no-useless-escape */
/* eslint-disable no-restricted-syntax */
const configGlobal = require('config');

const haproxyPrefix = `
global
  maxconn 500000
  log /dev/log    local0
  log /dev/log    local1 notice
  chroot /var/lib/haproxy
  stats socket /run/haproxy/admin.sock mode 660 level admin expose-fd listeners
  stats timeout 30s
  user haproxy
  group haproxy
  daemon

  # Default SSL material locations
  ca-base /etc/ssl/certs
  crt-base /etc/ssl/private

  # Default ciphers to use on SSL-enabled listening sockets.
  # For more onlinermation, see ciphers(1SSL). This list is from:
  #  https://hynek.me/articles/hardening-your-web-servers-ssl-ciphers/
  ssl-default-bind-ciphers ECDH+AESGCM:DH+AESGCM:ECDH+AES256:DH+AES256:ECDH+AES128:DH+AES:ECDH+3DES:DH+3DES:RSA+AESGCM:RSA+AES:RSA+3DES:!aNULL:!MD5:!DSS
  ssl-default-bind-options no-sslv3

defaults
  log     global
  mode    http
  option  httplog
  option  dontlognull
  timeout connect 5000
  timeout client  50000
  timeout server  50000
  maxconn 500000
  errorfile 400 /etc/haproxy/errors/400.http
  errorfile 403 /etc/haproxy/errors/403.http
  errorfile 408 /etc/haproxy/errors/408.http
  errorfile 500 /etc/haproxy/errors/500.http
  errorfile 502 /etc/haproxy/errors/502.http
  errorfile 503 /etc/haproxy/errors/503.http
  errorfile 504 /etc/haproxy/errors/504.http

frontend wwwhttp
  bind *:80
  option forwardfor except 127.0.0.0/8
  reqadd X-Forwarded-Proto:\\ http

  acl letsencrypt-acl path_beg /.well-known/acme-challenge/
  redirect scheme https if !letsencrypt-acl
  use_backend letsencrypt-backend if letsencrypt-acl
`;

const httpsPrefix = `
frontend wwwhttps
  option httplog
  option http-server-close
  option forwardfor except 127.0.0.0/8

  # stats in /fluxstatistics publicly available
  stats enable
  stats hide-version
  stats uri     /fluxstatistics
  stats realm   Flux\\ Statistics

  # The SSL CRT file is a combination of the public certificate and the private key
`;

const certificatePrefix = '  bind *:443 ssl ';

const certificatesSuffix = 'ciphers kEECDH+aRSA+AES:kRSA+AES:+AES256:RC4-SHA:!kEDH:!LOW:!EXP:!MD5:!aNULL:!eNULL no-sslv3';

const letsEncryptBackend = `backend letsencrypt-backend
  server letsencrypt 127.0.0.1:8787
`;

// eslint-disable-next-line no-unused-vars
function createCertificatesPaths(domains) {
  // let path = '';
  // domains.forEach((url) => {
  //   path += `crt /etc/ssl/${configGlobal.certFolder}/${url}.pem `;
  // });
  // return path;
  // ise directory
  const path = `crt /etc/ssl/${configGlobal.certFolder}/ `;
  return path;
}

function generateHaproxyConfig(acls, usebackends, domains, backends, redirects) {
  const config = `${haproxyPrefix}\n\n${acls}\n${usebackends}\n${redirects}\n${httpsPrefix}${certificatePrefix}${createCertificatesPaths(domains)}${certificatesSuffix}\n\n${acls}\n${usebackends}\n${redirects}\n\n${backends}\n${letsEncryptBackend}`;
  return config;
}

// appConfig is an array of object of domain, port, ips
function createKadenaHaproxyConfig(appConfig) {
  let backends = '';
  let acls = '';
  let usebackends = '';
  const domains = [];
  appConfig.forEach((app) => {
    const domainUsed = app.domain.split('.').join('');
    let domainBackend = `backend ${domainUsed}backend
  mode http
  balance source
  hash-type consistent
  stick-table type ip size 1m expire 1h
  stick on src`;
    for (const ip of app.ips) {
      console.log(app);
      console.log(app.ip);
      const a = ip.split('.');
      let IpString = '';
      for (let i = 0; i < 4; i += 1) {
        if (a[i].length === 3) {
          IpString += a[i];
        }
        if (a[i].length === 2) {
          IpString = `${IpString}0${a[i]}`;
        }
        if (a[i].length === 1) {
          IpString = `${IpString}00${a[i]}`;
        }
      }
      if (app.port === 31350) {
        domainBackend += `\n  server ${IpString} ${ip}:${app.port} check ssl verify none`;
      } else {
        domainBackend += `\n  server ${IpString} ${ip}:${app.port} check`;
      }
    }
    backends = `${backends + domainBackend}\n\n`;
    domains.push(app.domain);
    acls += `  acl ${domainUsed} hdr(host) ${app.domain}\n`;
    usebackends += `  use_backend ${domainUsed}backend if ${domainUsed}\n`;
  });

  domains.push('kadena2.app.runonflux.io');

  const chainwebAcl1 = '  acl chainwebB path_beg /chainweb/0.0/mainnet01/chain/0/pact\n';
  const chainwebAcl2 = '  acl chainwebB path_beg /chainweb/0.0/mainnet01/chain/1/pact\n';
  const chainwebAcl3 = '  acl chainwebB path_beg /chainweb/0.0/mainnet01/chain/2/pact\n';
  const chainwebAcl4 = '  acl chainwebB path_beg /chainweb/0.0/mainnet01/chain/3/pact\n';
  const chainwebAcl5 = '  acl chainwebB path_beg /chainweb/0.0/mainnet01/chain/4/pact\n';
  const chainwebAcl6 = '  acl chainwebB path_beg /chainweb/0.0/mainnet01/chain/5/pact\n';
  const chainwebAcl7 = '  acl chainwebB path_beg /chainweb/0.0/mainnet01/chain/6/pact\n';
  const chainwebAcl8 = '  acl chainwebB path_beg /chainweb/0.0/mainnet01/chain/7/pact\n';
  const chainwebAcl9 = '  acl chainwebB path_beg /chainweb/0.0/mainnet01/chain/8/pact\n';
  const chainwebAcl10 = '  acl chainwebB path_beg /chainweb/0.0/mainnet01/chain/9/pact\n';
  const chainwebAcl11 = '  acl chainwebB path_beg /chainweb/0.0/mainnet01/chain/10/pact\n';
  const chainwebAcl12 = '  acl chainwebB path_beg /chainweb/0.0/mainnet01/chain/11/pact\n';
  const chainwebAcl13 = '  acl chainwebB path_beg /chainweb/0.0/mainnet01/chain/12/pact\n';
  const chainwebAcl14 = '  acl chainwebB path_beg /chainweb/0.0/mainnet01/chain/13/pact\n';
  const chainwebAcl15 = '  acl chainwebB path_beg /chainweb/0.0/mainnet01/chain/14/pact\n';
  const chainwebAcl16 = '  acl chainwebB path_beg /chainweb/0.0/mainnet01/chain/15/pact\n';
  const chainwebAcl17 = '  acl chainwebB path_beg /chainweb/0.0/mainnet01/chain/16/pact\n';
  const chainwebAcl18 = '  acl chainwebB path_beg /chainweb/0.0/mainnet01/chain/17/pact\n';
  const chainwebAcl19 = '  acl chainwebB path_beg /chainweb/0.0/mainnet01/chain/18/pact\n';
  const chainwebAcl20 = '  acl chainwebB path_beg /chainweb/0.0/mainnet01/chain/19/pact\n';
  const chainwebAcl = '  acl chainweb path_beg /chainweb/0.0/mainnet01/cut\n';
  const chainwebAclB = '  acl chainweb path_beg /chainweb/0.0/mainnet01/chain\n';
  const chainwebAclC = '  acl chainweb path_beg /chainweb/0.0/mainnet01/config\n';
  const txsAcl = '  acl chainwebdata path_beg /txs\n';
  const coinsAcl = '  acl chainwebdata path_beg /coins\n';
  const statsAcl = '  acl chainwebdata path_beg /stats\n';
  acls += chainwebAcl1;
  acls += chainwebAcl2;
  acls += chainwebAcl3;
  acls += chainwebAcl4;
  acls += chainwebAcl5;
  acls += chainwebAcl6;
  acls += chainwebAcl7;
  acls += chainwebAcl8;
  acls += chainwebAcl9;
  acls += chainwebAcl10;
  acls += chainwebAcl11;
  acls += chainwebAcl12;
  acls += chainwebAcl13;
  acls += chainwebAcl14;
  acls += chainwebAcl15;
  acls += chainwebAcl16;
  acls += chainwebAcl17;
  acls += chainwebAcl18;
  acls += chainwebAcl19;
  acls += chainwebAcl20;
  acls += chainwebAcl;
  acls += chainwebAclB;
  acls += chainwebAclC;
  acls += txsAcl;
  acls += coinsAcl;
  acls += statsAcl;

  const defaultBackend = '  default_backend bkadenachainwebnode2apprunonfluxiobackend\n';
  const chainwebABackendUse = '  use_backend bkadenachainwebnode2apprunonfluxiobackend if chainwebB\n';
  const chainwebBackendUse = '  use_backend akadenachainwebnode2apprunonfluxiobackend if chainweb\n';
  const chainwebDataBackendUse = '  use_backend akadenachainwebdata2apprunonfluxiobackend if chainwebdata\n';
  usebackends += chainwebABackendUse;
  usebackends += chainwebBackendUse;
  usebackends += chainwebDataBackendUse;
  usebackends += defaultBackend;

  const redirects = '';

  return generateHaproxyConfig(acls, usebackends, domains, backends, redirects);
}

module.exports = {
  createKadenaHaproxyConfig,
};

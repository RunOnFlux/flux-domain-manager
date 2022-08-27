/* eslint-disable no-useless-escape */
/* eslint-disable no-restricted-syntax */
const configGlobal = require('config');
const log = require('../lib/log');

const haproxyPrefix = `
global
  maxconn 50000
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
  maxconn 50000
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
  http-request add-header X-Forwarded-Proto http

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

const h2Suffix = 'alpn h2,http/1.1';

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
  const config = `${haproxyPrefix}\n\n${acls}\n${usebackends}\n${redirects}\n${httpsPrefix}${certificatePrefix}${createCertificatesPaths(domains)}${certificatesSuffix} ${h2Suffix}\n\n${acls}\n${usebackends}\n${redirects}\n\n${backends}\n${letsEncryptBackend}`;
  return config;
}

function createMainHaproxyConfig(ui, api, fluxIPs) {
  const uiB = ui.split('.').join('');
  let uiBackend = `backend ${uiB}backend
  mode http
  balance source
  hash-type consistent
  stick-table type ip size 1m expire 8h
  stick on src`;
  for (const ip of fluxIPs) {
    const uiPort = ip.split(':')[1] || 16126;
    const a = ip.split(':')[0].split('.');
    const b = ip.split(':')[1] || '';
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
    uiBackend += `\n  server ${IpString}${b} ${ip.split(':')[0]}:${uiPort} check`;
  }
  // console.log(uiBackend);

  const apiB = api.split('.').join('');
  let apiBackend = `backend ${apiB}backend
  mode http
  balance source
  hash-type consistent
  stick-table type ip size 1m expire 8h
  stick on src`;
  for (const ip of fluxIPs) {
    const apiPort = ip.split(':')[1] || 16127;
    const a = ip.split(':')[0].split('.');
    const b = ip.split(':')[1] || '';
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
    apiBackend += `\n  server ${IpString}${b} ${ip.split(':')[0]}:${apiPort} check`;
  }
  // console.log(apiBackend);

  const redirects = '  http-request redirect code 301 location https://home.runonflux.io/dashboard/overview if { hdr(host) -i dashboard.zel.network }\n\n';
  const uiAcl = `  acl ${uiB} hdr(host) ${ui}\n`;
  const apiAcl = `  acl ${apiB} hdr(host) ${api}\n`;
  const uiBackendUse = `  use_backend ${uiB}backend if ${uiB}\n`;
  const apiBackendUse = `  use_backend ${apiB}backend if ${apiB}\n`;

  const acls = uiAcl + apiAcl;
  const usebackends = uiBackendUse + apiBackendUse;

  const backends = `${uiBackend}\n\n${apiBackend}`;
  const urls = [ui, api, 'dashboard.zel.network'];

  return generateHaproxyConfig(acls, usebackends, urls, backends, redirects);
}

// appConfig is an array of object of domain, port, ips
function createAppsHaproxyConfig(appConfig) {
  let backends = '';
  let acls = '';
  let usebackends = '';
  const domains = [];
  appConfig.forEach((app) => {
    const domainUsed = app.domain.split('.').join('');
    let domainBackend = `backend ${domainUsed}backend
  mode http`;
    if (app.loadBalance) {
      domainBackend += app.loadBalance;
    } else {
      domainBackend += '\n  balance source';
      domainBackend += '\n  hash-type consistent';
      domainBackend += '\n  stick-table type ip size 1m expire 1h';
      domainBackend += '\n  stick on src';
    }
    if (app.headers) {
      // eslint-disable-next-line no-loop-func
      app.headers.forEach((header) => {
        domainBackend += `\n  ${header}`;
      });
    }
    // eslint-disable-next-line no-loop-func
    app.healthcheck.forEach((hc) => {
      domainBackend += `\n  ${hc}`;
    });
    for (const ip of app.ips) {
      const a = ip.split(':')[0].split('.');
      if (!a) {
        log.error('STRANGE IP');
        log.error(ip);
        continue;
      }
      let IpString = '';
      const b = ip.split(':')[1] || '';
      for (let i = 0; i < 4; i += 1) {
        if (!(a[i])) {
          log.error('STRANGE IP');
          log.error(ip);
          continue;
        }
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

      if (app.ssl) {
        const h2Config = app.enableH2 ? h2Suffix : '';
        domainBackend += `\n  server ${IpString}${b} ${ip.split(':')[0]}:${app.port} check ${app.serverConfig} ssl verify none ${h2Config}`;
      } else {
        domainBackend += `\n  server ${IpString}${b} ${ip.split(':')[0]}:${app.port} check ${app.serverConfig}`;
      }
      if (app.timeout) {
        domainBackend += `\n  timeout server ${app.timeout}`;
      }
    }
    backends = `${backends + domainBackend}\n\n`;
    domains.push(app.domain);
    acls += `  acl ${domainUsed} hdr(host) ${app.domain}\n`;
    usebackends += `  use_backend ${domainUsed}backend if ${domainUsed}\n`;
  });
  const redirects = '';

  return generateHaproxyConfig(acls, usebackends, domains, backends, redirects);
}

module.exports = {
  createMainHaproxyConfig,
  createAppsHaproxyConfig,
};

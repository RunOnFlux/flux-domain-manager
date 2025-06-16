/* eslint-disable no-useless-escape */
/* eslint-disable no-restricted-syntax */
const configGlobal = require('config');
const fs = require('fs').promises;
const log = require('../lib/log');
const { cmdAsync, TEMP_HAPROXY_CONFIG, HAPROXY_CONFIG } = require('./constants');
const { matchRule } = require('./serviceHelper');

let lastHaproxyConfig;

const haproxyPrefix = `
global
  ${configGlobal.cloudflare.manageapp ? 'lua-load /etc/haproxy/haproxy_minecraft.lua' : ''}
  maxconn 50000
  log /dev/log    local0 info alert
  log /dev/log    local1 warning alert
  chroot /var/lib/haproxy
  stats socket /run/haproxy/admin.sock mode 660 level admin expose-fd listeners
  stats timeout 30s
  user haproxy
  group haproxy
  daemon
  server-state-file /tmp/server-state             # State file path

  # Default SSL material locations
  ca-base /etc/ssl/certs
  crt-base /etc/ssl/private

  # intermediate configuration
  ssl-default-bind-curves X25519:prime256v1:secp384r1
  ssl-default-bind-ciphers ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305:DHE-RSA-AES128-GCM-SHA256:DHE-RSA-AES256-GCM-SHA384
  ssl-default-bind-ciphersuites TLS_AES_128_GCM_SHA256:TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256
  ssl-default-bind-options prefer-client-ciphers ssl-min-ver TLSv1.2 no-tls-tickets

  ssl-default-server-curves X25519:prime256v1:secp384r1
  ssl-default-server-ciphers ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305:DHE-RSA-AES128-GCM-SHA256:DHE-RSA-AES256-GCM-SHA384
  ssl-default-server-ciphersuites TLS_AES_128_GCM_SHA256:TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256
  ssl-default-server-options ssl-min-ver TLSv1.2 no-tls-tickets

  # curl https://ssl-config.mozilla.org/ffdhe4096.txt > /etc/haproxy/dhparam
  ssl-dh-param-file /etc/haproxy/dhparam

defaults
  load-server-state-from-file global
  log     global
  mode    http
#  option  httplog
  option  dontlognull
  timeout connect 10000
  timeout client  120000
  timeout server  120000
  maxconn 100000
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
  http-response add-header Access-Control-Expose-Headers '*'
  http-after-response set-header Access-Control-Allow-Origin "*"

  acl letsencrypt-acl path_beg /.well-known/acme-challenge/
  acl cloudflare-flux-acl path_beg /.well-known/pki-validation/
  redirect scheme https if !letsencrypt-acl !cloudflare-flux-acl
  use_backend letsencrypt-backend if letsencrypt-acl
  use_backend cloudflare-flux-backend if cloudflare-flux-acl
`;

const httpsPrefix = `
frontend wwwhttps
#  option httplog
  option http-server-close
  option forwardfor except 127.0.0.0/8
  http-response add-header Access-Control-Expose-Headers '*'
  http-after-response set-header Access-Control-Allow-Origin "*"

  # stats in /fluxstatistics publicly available
  stats enable
  stats hide-version
  stats uri     /fluxstatistics
  stats realm   Flux\\ Statistics

  # The SSL CRT file is a combination of the public certificate and the private key
`;

const certificatePrefix = '  bind *:443 ssl ';

const certificatesSuffix = ''; // 'ciphers kEECDH+aRSA+AES:kRSA+AES:+AES256:RC4-SHA:!kEDH:!LOW:!EXP:!MD5:!aNULL:!eNULL no-sslv3';

const h2Suffix = 'alpn h2,http/1.1';

const letsEncryptBackend = `backend letsencrypt-backend
  server letsencrypt 127.0.0.1:8787
`;

const cloudflareFluxBackend = `backend cloudflare-flux-backend
  server cloudflareflux 127.0.0.1:${configGlobal.server.port}
`;

const forbiddenBackend = `backend forbidden-backend
  mode http
  http-request deny deny_status 403
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

/*
function generateMinecraftSettings(minecraftAppsMap) {
  let configs = '';
  for (const port of Object.keys(minecraftAppsMap)) {
    const portConf = minecraftAppsMap[port];
    const tempFrontend = `
frontend minecraft_${port}
  bind 0.0.0.0:${port}
  mode tcp
  tcp-request inspect-delay 5s
  tcp-request content accept if { req_ssl_hello_type 1 }
  option tcplog
  option tcp-check
${portConf.acls.join('\n')}
${portConf.usebackends.join('')}
${portConf.backends.join('\n')}`;

    configs = `${configs}\n\n${tempFrontend}`;
  }

  return configs;
}
*/

function generateAppsTCPSettings(tcpAppsMap) {
  let configs = '';
  for (const port of Object.keys(tcpAppsMap)) {
    if (+port === 443 || +port === 80) { // hot fix do not forward 80 and 443
      // eslint-disable-next-line no-continue
      continue;
    }
    const portConf = tcpAppsMap[port];
    const tempFrontend = `
frontend tcp_app_${port}
  bind 0.0.0.0:${port}
  mode tcp
  option tcplog
  option tcp-check
  tcp-request inspect-delay 5s
  ${+port === 25565 ? `tcp-request content lua.mc_handshake
  # tcp-request content reject if { var(txn.mc_proto) -m int 0 }
  tcp-request content accept if { var(txn.mc_proto) -m found }
  # tcp-request content reject if WAIT_END` : 'tcp-request content accept if { req_ssl_hello_type 1 }'}
${portConf.acls.join('\n')}
${portConf.usebackends.join('')}
${portConf.backends.join('\n')}`;

    configs = `${configs}\n\n${tempFrontend}`;
  }

  return configs;
}

function generateHaproxyConfig(acls, usebackends, domains, backends, redirects, minecraftAppsMap = {}, tcpAppsMap = {}) {
  // eslint-disable-next-line max-len
  // const minecraftConfig = generateMinecraftSettings(minecraftAppsMap);
  const tcpConfig = generateAppsTCPSettings(tcpAppsMap);
  const config = `
${haproxyPrefix}

${acls}
${usebackends}
${redirects}

${tcpConfig}

${httpsPrefix}${certificatePrefix}${createCertificatesPaths(domains)}${certificatesSuffix} ${h2Suffix}

${acls}
${usebackends}
${redirects}

${backends}
${letsEncryptBackend}
${cloudflareFluxBackend}
${forbiddenBackend}
`;
  return config;
}

function generateDomainBackend(app, mode) {
  let domainUsed = app.domain.split('.').join('');
  if (mode === 'tcp') {
    domainUsed += '_tcp_';
  }
  let domainBackend = `
backend ${domainUsed}backend
  mode ${mode}`;
  if (app.loadBalance) {
    domainBackend += app.loadBalance;
  } else if (mode !== 'tcp') {
    domainBackend += '\n  balance roundrobin';
    if (app.ips.length > 1) {
      domainBackend += '\n  cookie FDMSERVERID insert preserve indirect nocache maxlife 8h';
    }
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
    if (!ip) {
      log.error('MISSING IP');
      log.error(ip);
      // eslint-disable-next-line no-continue
      continue;
    }
    if (!ip.split(':')[0]) {
      log.error('INTERESTING IP');
      log.error(ip);
      // eslint-disable-next-line no-continue
      continue;
    }
    const a = ip.split(':')[0].split('.');
    if (!a) {
      log.error('STRANGE IP');
      log.error(ip);
      // eslint-disable-next-line no-continue
      continue;
    }

    if (app.ips[0] === ip) {
      if (app.timeout) {
        domainBackend += `\n  timeout http-request ${app.timeout}`;
      } else {
        domainBackend += '\n  timeout http-request 15s'; //  timeout connect 15s
      }
      if (app.timeout) {
        domainBackend += `\n  timeout server ${app.timeout}`;
      } else if (app.isRdata) {
        domainBackend += '\n  timeout server 20s';
      } else {
        domainBackend += '\n  timeout server 25s';
      }
      domainBackend += '\n  retries 3\n  retry-on conn-failure response-timeout empty-response 500\n  option redispatch 1';
    }

    const apiPort = ip.split(':')[1] || 16127;
    let cookieConfig = app.loadBalance || mode === 'tcp' ? '' : `cookie ${ip.split(':')[0]}:${app.port}`;
    const isCheck = app.check ? 'check ' : '';
    if (ip.includes('[') && ip.includes(']')) { // ipv6 hardcoded
      const h2Config = app.enableH2 ? `${h2Suffix} ` : '';
      cookieConfig = app.loadBalance || mode === 'tcp' ? '' : `cookie ${ip.split('[')[1].split(']')[0]}${ip.split(']')[1]}`;
      domainBackend += `\n  server ${ip.split('[')[1].split(']')[0]} ${ip.split(']')[0]}]${ip.split(']')[1]} ${isCheck}${app.serverConfig} ssl verify none ${h2Config}${cookieConfig}`;
    } else if (app.ssl) {
      const h2Config = app.enableH2 ? `${h2Suffix} ` : '';
      domainBackend += `\n  server ${ip.split(':')[0]}:${apiPort} ${ip.split(':')[0]}:${app.port} ${isCheck}${app.serverConfig} ssl verify none ${h2Config}${cookieConfig}`;
    } else {
      domainBackend += `\n  server ${ip.split(':')[0]}:${apiPort} ${ip.split(':')[0]}:${app.port} ${isCheck}${app.serverConfig} ${cookieConfig}`;
    }

    domainBackend += ' inter 3s fall 2 rise 2 fastinter 500';
    if (app.isRdata) {
      if (app.ips[0] !== ip) {
        domainBackend += ' backup';
      }
    }
  }
  return domainBackend;
}

function generateMinecraftACLs(app) {
  console.log(app.domain);
  const aclName = app.domain.split('.').join('');
  const appName = app.domain.split('.')[0];
  console.log(appName);

  const nameLength = appName.length + 1;
  const domainLength = app.domain.length;
  return [
    `  acl ${aclName} var(txn.mc_host) -i -m dom ${app.domain}`,
    `  acl ${aclName} req.payload(4,${nameLength}) -m sub ${appName}.`,
    `  acl ${aclName} req.payload(5,${nameLength}) -m sub ${appName}.`,
    `  acl ${aclName} req.payload(7,${nameLength}) -m sub ${appName}.`,
    `  acl ${aclName} req.payload(8,${nameLength}) -m sub ${appName}.`,
    `  acl ${aclName} req.payload(1,${domainLength}) -m sub ${app.domain}`,
    `  acl ${aclName} req.payload(2,${domainLength}) -m sub ${app.domain}`,
    `  acl ${aclName} req.payload(3,${domainLength}) -m sub ${app.domain}`,
  ];
}

function createMainHaproxyConfig(ui, api, fluxIPs, uiPrimary, apiPrimary) {
  const uiB = ui.split('.').join('');
  let uiBackend = `backend ${uiB}backend
    http-response set-header FLUXNODE %s
    mode http
    balance source`;

  for (const ip of fluxIPs) {
    const apiPort = ip.split(':')[1] || '16127';
    const uiPort = Number(apiPort) - 1;
    const serverName = (`${ip.split(':')[0]}.${uiPort}`).replace(/\./g, '_');
    uiBackend += `\n  server ${serverName} ${ip.split(':')[0]}:${uiPort} check`;
  }

  const apiB = api.split('.').join('');

  // Regular API backend
  let apiBackend = `backend ${apiB}backend
    http-response set-header FLUXNODE %s
    mode http
    balance source
    option httpchk GET /health`;

  // WebSocket backend with same source balancing
  let wsBackend = `backend ${apiB}wsbackend
    http-response set-header FLUXNODE %s
    mode http
    balance source
    timeout tunnel 3600s
    timeout server 3600s`;

  for (const ip of fluxIPs) {
    const apiPort = ip.split(':')[1] || '16127';
    const serverName = (`${ip.split(':')[0]}.${apiPort}`).replace(/\./g, '_');
    apiBackend += `\n  server ${serverName} ${ip.split(':')[0]}:${apiPort} check`;
    wsBackend += `\n  server ${serverName} ${ip.split(':')[0]}:${apiPort} check`;
  }

  const redirects = '  http-request redirect code 301 location https://home.runonflux.io/dashboard/overview if { hdr(host) -i dashboard.zel.network }\n\n';

  const webSocketAcl = '  acl is_websocket hdr(connection) -i upgrade\n';
  const uiAcl = `  acl ${uiB} hdr(host) ${ui}\n`;
  const apiAcl = `  acl ${apiB} hdr(host) ${api}\n`;
  let acls = webSocketAcl + uiAcl + apiAcl;

  if (uiPrimary) {
    const uiPrimaryAcl = `  acl ${uiB} hdr(host) ${uiPrimary}\n`;
    acls += uiPrimaryAcl;
  }
  if (apiPrimary) {
    const apiPrimaryAcl = `  acl ${apiB} hdr(host) ${apiPrimary}\n`;
    acls += apiPrimaryAcl;
  }

  const wsBackendUse = `  use_backend ${apiB}wsbackend if is_websocket ${apiB}\n`;
  const uiBackendUse = `  use_backend ${uiB}backend if ${uiB}\n`;
  const apiBackendUse = `  use_backend ${apiB}backend if ${apiB}\n`;

  const usebackends = wsBackendUse + uiBackendUse + apiBackendUse;
  const backends = `${uiBackend}\n\n${apiBackend}\n\n${wsBackend}`;
  const urls = [ui, api, 'dashboard.zel.network', uiPrimary, apiPrimary];

  return generateHaproxyConfig(acls, usebackends, urls, backends, redirects, {}, {});
}

// appConfig is an array of object of domain, port, ips
function createAppsHaproxyConfig(appConfig) {
  let backends = '';
  let acls = '';
  let usebackends = '';
  // acls += '  acl forbiddenacl hdr(host) kaddex.com\n';
  // acls += '  acl forbiddenacl hdr(host) www.kaddex.com\n';
  // acls += '  acl forbiddenacl hdr(host) ecko.finance\n';
  // acls += '  acl forbiddenacl hdr(host) www.ecko.finance\n';
  // acls += '  acl forbiddenacl hdr(host) dao.ecko.finance\n';
  acls += '  acl forbiddenacl path_beg -i /product/litty-cat-thc-bars-1000mg\n';
  usebackends += '  use_backend forbidden-backend if forbiddenacl\n';
  const domains = [];
  const seenApps = {};
  const minecraftAppsMap = {};
  const tcpAppsMap = {};
  for (const app of appConfig) {
    if (domains.includes(app.domain)) {
      // eslint-disable-next-line no-continue
      continue;
    }
    if (app.appName in seenApps) {
      domains.push(app.domain);
      acls += `  acl ${seenApps[app.appName]} hdr(host) ${app.domain}\n`;
    } else if (matchRule(app.name.toLowerCase(), configGlobal.minecraftApps)) {
      const domainUsed = app.domain.split('.').join('');
      const { port } = app;
      if (!(port in minecraftAppsMap)) {
        minecraftAppsMap[port] = {
          acls: [],
          usebackends: [],
          backends: [],
        };
      }
      const tempMinecraftACLs = generateMinecraftACLs(app);
      const domainBackend = generateDomainBackend(app, 'tcp');
      minecraftAppsMap[port].acls = minecraftAppsMap[port].acls.concat(tempMinecraftACLs);
      minecraftAppsMap[port].usebackends.push(`  use_backend ${domainUsed}_tcp_backend if ${domainUsed}\n`);
      if (!minecraftAppsMap[port].backends.includes(domainBackend)) {
        minecraftAppsMap[port].backends.push(domainBackend);
      }
    } else {
      const domainUsed = app.domain.split('.').join('');
      if (usebackends.includes(`  use_backend ${domainUsed}backend if ${domainUsed}\n`)) {
        // eslint-disable-next-line no-continue
        continue;
      }
      const domainBackend = generateDomainBackend(app, 'http');
      backends = `${backends + domainBackend}\n\n`;
      domains.push(app.domain);
      acls += `  acl ${domainUsed} hdr(host) ${app.domain}\n`;
      usebackends += `  use_backend ${domainUsed}backend if ${domainUsed}\n`;
      seenApps[app.appName] = domainUsed;
    }
    if (app.mode === 'tcp') {
      log.info(`TCP APP: ${app.name}`);
      // also configure tcp
      const domainUsed = app.domain.split('.').join('');
      const { port } = app;
      if (!(port in tcpAppsMap)) {
        tcpAppsMap[port] = {
          acls: [],
          usebackends: [],
          backends: [],
        };
      }

      const tempMinecraftACLs = generateMinecraftACLs(app);
      const domainBackend = generateDomainBackend(app, 'tcp');
      if (!tcpAppsMap[port].usebackends.length) {
        tcpAppsMap[port].usebackends.push(`  default_backend ${domainUsed}_tcp_backend\n`);
      }
      if (!tcpAppsMap[port].backends.length) {
        tcpAppsMap[port].backends.push(domainBackend);
      }
      tcpAppsMap[port].acls = tcpAppsMap[port].acls.concat(tempMinecraftACLs);
      const aclName = app.domain.split('.').join('');
      tcpAppsMap[port].acls.push(`  acl ${aclName} req.ssl_sni -i ${app.domain}`);
      tcpAppsMap[port].usebackends.push(`  use_backend ${domainUsed}_tcp_backend if ${domainUsed}\n`);
      if (!tcpAppsMap[port].backends.includes(domainBackend)) {
        tcpAppsMap[port].backends.push(domainBackend);
      }
    }
  }
  const redirects = '';

  return generateHaproxyConfig(acls, usebackends, domains, backends, redirects, minecraftAppsMap, tcpAppsMap);
}

async function writeConfig(configName, data) {
  await fs.writeFile(configName, data);
}

async function checkConfig(configName) {
  const response = await cmdAsync(`sudo haproxy -f ${configName} -c`);
  const configOK = (response.includes('Configuration file is valid') || response.includes('Warnings were found.'));
  return configOK;
}

async function restartProxy(dataToWrite) {
  await writeConfig(TEMP_HAPROXY_CONFIG, dataToWrite);
  const isConfigOk = await checkConfig(TEMP_HAPROXY_CONFIG);
  if (!isConfigOk) {
    log.info('Haproxy config is invalid. Not restarting');
    return false;
  }
  if (lastHaproxyConfig === dataToWrite) {
    log.info('Haproxy config is the same as last time. Not restarting.');
    return true;
  }
  lastHaproxyConfig = dataToWrite;
  await writeConfig(HAPROXY_CONFIG, dataToWrite);
  const execCreateStateFile = 'echo "show servers state" | sudo socat /run/haproxy/admin.sock - > /tmp/server-state';
  await cmdAsync(execCreateStateFile);
  const execHAreload = 'sudo service haproxy reload';
  await cmdAsync(execHAreload);
  log.info('Haproxy reloaded');
  return true;
}

module.exports = {
  createMainHaproxyConfig,
  createAppsHaproxyConfig,
  restartProxy,
};

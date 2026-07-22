/* eslint-disable no-useless-escape */
/* eslint-disable no-restricted-syntax */
const configGlobal = require('config');
const fs = require('fs').promises;
const log = require('../lib/log');
const { cmdAsync, TEMP_HAPROXY_CONFIG, HAPROXY_CONFIG } = require('./constants');
const { matchRule } = require('./serviceHelper');
const { getPrimaryIP } = require('./rsync/config');
const { resolveBackendConfig } = require('./haproxy/resolveBackendConfig');
const { Section, Directive, parse } = require('./haproxy/configModel');

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
  http-response add-header Access-Control-Expose-Headers '*' unless { res.hdr(Access-Control-Expose-Headers) -m found }
  http-after-response add-header Access-Control-Allow-Origin "*" unless { res.hdr(Access-Control-Allow-Origin) -m found }

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
  http-response add-header Access-Control-Expose-Headers '*' unless { res.hdr(Access-Control-Expose-Headers) -m found }
  http-after-response add-header Access-Control-Allow-Origin "*" unless { res.hdr(Access-Control-Allow-Origin) -m found }

  # stats in /fluxstatistics publicly available
  stats enable
  stats hide-version
  stats uri     /fluxstatistics
  stats realm   Flux\\ Statistics

  # The SSL CRT file is a combination of the public certificate and the private key
`;

const httpsFdmApiPrefix = `
  # FDM API routing - only for this FDM's domain
  acl fdm-domain hdr(host) -i ${configGlobal.fdmAppDomain}
  acl fdm-api-path path_beg /api/
  use_backend fdm-api-backend if fdm-domain fdm-api-path
`;

const certificatePrefix = '  bind *:443 ssl ';

const certificatesSuffix = ''; // 'ciphers kEECDH+aRSA+AES:kRSA+AES:+AES256:RC4-SHA:!kEDH:!LOW:!EXP:!MD5:!aNULL:!eNULL no-sslv3';

const h2Suffix = 'alpn h2,http/1.1';

const letsEncryptBackend = (() => {
  if (configGlobal.certRenewalPrimary) {
    return `backend letsencrypt-backend
  server letsencrypt 127.0.0.1:8787
`;
  }
  // Non-primary: proxy ACME challenges to the primary's certbot
  const primaryIP = getPrimaryIP();
  if (!primaryIP) {
    log.error('certRenewalPrimary is false but no primary IP found in hosts.ini. ACME challenges will fail.');
  }
  const target = primaryIP || '127.0.0.1';
  return `backend letsencrypt-backend
  server letsencrypt ${target}:8787
`;
})();

const cloudflareFluxBackend = `backend cloudflare-flux-backend
  server cloudflareflux 127.0.0.1:${configGlobal.server.port}
`;

const fdmApiBackend = `backend fdm-api-backend
  http-request set-path %[path,regsub(^/api/,/)]
  server fdm-api 127.0.0.1:${configGlobal.server.port}
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
${httpsFdmApiPrefix}

${acls}
${usebackends}
${redirects}

${backends}
${letsEncryptBackend}
${cloudflareFluxBackend}
${fdmApiBackend}
${forbiddenBackend}
`;
  return config;
}

// The per-server health-check timing legacy emits inline on every server line.
const LEGACY_SERVER_TIMING = 'inter 3s fall 2 rise 2 fastinter 500';

// Append one backend server line to `section`. The clause order matches legacy for a
// legacy route and the v9 shape for a v9 route; either way absent clauses are passed
// as '' and dropped by the model, so no trailing/doubled whitespace survives.
function addServerLine(section, cfg, app, mode, ip) {
  const host = ip.split(':')[0];
  const apiPort = ip.split(':')[1] || 16127;
  const backup = (app.syncFirst && app.ips[0] !== ip) ? 'backup' : '';

  if (cfg.isV9) {
    const serverName = `${host}:${apiPort}`;
    const cookie = cfg.stickyV9 ? `cookie ${serverName}` : '';
    section.add('server', ...[
      serverName, `${host}:${app.port}`, 'check',
      cfg.serverTiming, cfg.serverMaxconn, cfg.serverSsl, cookie, backup,
    ]);
    return;
  }

  const check = app.check ? 'check' : '';
  if (ip.includes('[') && ip.includes(']')) { // ipv6
    const v6host = ip.split('[')[1].split(']')[0];
    const v6addr = `${ip.split(']')[0]}]${ip.split(']')[1]}`;
    const cookie = app.loadBalance || mode === 'tcp' ? '' : `cookie ${v6host}${ip.split(']')[1]}`;
    const h2 = app.enableH2 ? h2Suffix : '';
    section.add('server', ...[
      v6host, v6addr, check, app.serverConfig,
      'ssl verify none', h2, cookie, LEGACY_SERVER_TIMING, backup,
    ]);
    return;
  }
  const cookie = app.loadBalance || mode === 'tcp' ? '' : `cookie ${host}:${app.port}`;
  // Legacy emits alpn/h2 only alongside backend TLS; gate it on the resolved ssl clause.
  const h2 = cfg.serverSsl && app.enableH2 ? h2Suffix : '';
  section.add('server', ...[
    `${host}:${apiPort}`, `${host}:${app.port}`, check, app.serverConfig,
    cfg.serverSsl, h2, cookie, LEGACY_SERVER_TIMING, backup,
  ]);
}

function generateDomainBackend(app, mode) {
  let domainUsed = app.domain.split('.').join('');
  if (mode === 'tcp') {
    domainUsed += '_tcp_';
  }
  const cfg = resolveBackendConfig(app, mode);
  const section = new Section('backend', `${domainUsed}backend`);
  section.add('mode', mode);
  // Backend-level directives — balance (+ affinity cookie), request headers, and the
  // health-check probe — resolved version-blind by resolveBackendConfig.
  cfg.balanceLines.forEach((line) => section.raw(line));
  cfg.headerLines.forEach((line) => section.raw(line));
  cfg.healthCheckLines.forEach((line) => section.raw(line));

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

    // Backend timeouts + retries, emitted once (with the first server).
    if (app.ips[0] === ip) {
      cfg.onceLines.forEach((line) => section.raw(line));
    }
    addServerLine(section, cfg, app, mode, ip);
  }
  return section;
}

function generateMinecraftACLs(app) {
  const aclName = app.domain.split('.').join('');
  const appName = app.domain.split('.')[0];

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

function createMainHaproxyConfig(ui, api, fluxIPs, uiPrimary, apiPrimary, cloudUi, cloudUiPrimary) {
  const uiB = ui.split('.').join('');
  const apiB = api.split('.').join('');

  // Sort IPs for consistent ordering
  const sortedFluxIPs = [...fluxIPs].sort();

  // Create server mapping with IDENTICAL order and count
  const serverMapping = sortedFluxIPs.map((ip, index) => {
    const apiPort = ip.split(':')[1] || '16127';
    const uiPort = Number(apiPort) - 1;
    const baseHost = ip.split(':')[0];
    return {
      index: index + 1,
      baseHost,
      uiPort,
      apiPort,
      serverName: `server${index + 1}_${baseHost}`,
    };
  });

  // API backend with source-based load balancing (for session persistence)
  let apiBackend = `backend ${apiB}backend
    http-response set-header FLUXNODE %s
    mode http
    balance source
    # FAILOVER: Allow fallback to other servers if primary fails
    option redispatch
    # RETRY: Retry failed requests automatically
    retries 3
    # Enhanced WebSocket support
    timeout tunnel 7200s
    timeout server 30s
    timeout connect 5s
    # WebSocket connection handling
    option http-keep-alive
    no option httpclose
    # Health check with faster detection of failed servers
    default-server check inter 10s fall 2 rise 3 maxconn 100`;

  // Roundrobin API backend for specific endpoints that need random distribution
  let apiRoundrobinBackend = `backend ${apiB}roundrobinbackend
    http-response set-header FLUXNODE %s
    http-response set-header X-Flux-Mode "Roundrobin"
    mode http
    balance roundrobin
    # FAILOVER: Allow fallback to other servers if primary fails
    option redispatch
    # RETRY: Retry failed requests automatically
    retries 3
    # Enhanced WebSocket support
    timeout tunnel 7200s
    timeout server 120s
    timeout connect 5s
    # WebSocket connection handling
    option http-keep-alive
    no option httpclose
    # Health check with faster detection of failed servers
    default-server check inter 10s fall 2 rise 3 maxconn 100`;

  // UI backend with load balancing based on real client IP (CF-Connecting-IP)
  let uiBackend = `backend ${uiB}backend
    http-response set-header FLUXNODE %s
    mode http
    balance hdr(CF-Connecting-IP)
    # FAILOVER: Allow fallback when primary server fails
    option redispatch
    # RETRY: Retry failed requests
    retries 3
    # Standard HTTP timeouts
    timeout server 30s
    timeout connect 5s
    # Health check with faster failure detection
    default-server check inter 10s fall 2 rise 3 maxconn 100`;

  for (const server of serverMapping) {
    uiBackend += `\n  server ${server.serverName} ${server.baseHost}:${server.uiPort} check`;
    apiBackend += `\n  server ${server.serverName} ${server.baseHost}:${server.apiPort} check`;
    apiRoundrobinBackend += `\n  server ${server.serverName} ${server.baseHost}:${server.apiPort} check`;
  }

  const redirects = '  http-request redirect code 301 location https://cloud.runonflux.com/dashboards/overview if { hdr(host) -i dashboard.zel.network }\n\n';

  // Enhanced ACLs with WebSocket detection and specific endpoint detection
  const specificEndpointsAcl = `  acl is_sticky_endpoint path_beg /id/loginphrase
  acl is_sticky_endpoint path_beg /id/emergencyphrase
  acl is_sticky_endpoint path_beg /id/providesign
  acl is_sticky_endpoint path_beg /id/verifylogin\n`;

  // ACLs for endpoints that should use roundrobin
  const roundrobinEndpointsAcl = `  acl is_roundrobin_endpoint path_beg apps/calculatefiatandfluxprice
  acl is_roundrobin_endpoint path_beg /apps/verifyappregistrationspecifications
  acl is_roundrobin_endpoint path_beg /apps/verifyappupdatespecifications
  acl is_roundrobin_endpoint path_beg /apps/appregister
  acl is_roundrobin_endpoint path_beg /apps/appupdate
  acl is_roundrobin_endpoint path_beg /apps/temporarymessages
  acl is_roundrobin_endpoint path_beg /apps/location
  acl is_roundrobin_endpoint path_beg /apps/testappinstall\n`;

  const webSocketAcl = `  acl is_websocket hdr(connection) -i upgrade
  acl is_websocket_upgrade hdr(upgrade) -i websocket\n`;

  const uiAcl = `  acl ${uiB} hdr(host) ${ui}\n`;
  const apiAcl = `  acl ${apiB} hdr(host) ${api}\n`;
  let acls = specificEndpointsAcl + roundrobinEndpointsAcl + webSocketAcl + uiAcl + apiAcl;

  if (uiPrimary) {
    const uiPrimaryAcl = `  acl ${uiB} hdr(host) ${uiPrimary}\n`;
    acls += uiPrimaryAcl;
  }
  if (apiPrimary) {
    const apiPrimaryAcl = `  acl ${apiB} hdr(host) ${apiPrimary}\n`;
    acls += apiPrimaryAcl;
  }
  // Cloud UI uses same backend as home UI
  const cloudUiAcl = `  acl ${uiB} hdr(host) ${cloudUi}\n`;
  acls += cloudUiAcl;
  if (cloudUiPrimary) {
    const cloudUiPrimaryAcl = `  acl ${uiB} hdr(host) ${cloudUiPrimary}\n`;
    acls += cloudUiPrimaryAcl;
  }

  // Enhanced routing with roundrobin endpoints getting priority
  const wsBackendUse = `  use_backend ${apiB}backend if is_websocket ${apiB}\n`;
  const roundrobinBackendUse = `  use_backend ${apiB}roundrobinbackend if ${apiB} is_roundrobin_endpoint\n`;
  const uiBackendUse = `  use_backend ${uiB}backend if ${uiB}\n`;
  const apiBackendUse = `  use_backend ${apiB}backend if ${apiB}\n`;

  const usebackends = wsBackendUse + roundrobinBackendUse + uiBackendUse + apiBackendUse;
  const backends = `${uiBackend}\n\n${apiBackend}\n\n${apiRoundrobinBackend}`;
  const urls = [ui, api, 'dashboard.zel.network', uiPrimary, apiPrimary, cloudUi, cloudUiPrimary];

  return generateHaproxyConfig(acls, usebackends, urls, backends, redirects, {}, {});
}

// appConfig is an array of object of domain, port, ips
function createAppsHaproxyConfig(appConfig) {
  // Static skeleton: global, defaults, and frontend wwwhttp (with its acme/redirect
  // setup), folded into the model from the existing template.
  const config = parse(haproxyPrefix);
  const wwwhttp = config.sections.find((s) => s.name === 'wwwhttp');

  // Per-app routing shared verbatim by both http frontends: acl definitions then
  // use_backends. Plus the http backend sections and the tcp frontends/backends.
  const routingAcls = [];
  const routingUseBackends = [];
  const backendSections = [];
  const domains = [];
  const seenApps = {};
  const minecraftAppsMap = {};
  const tcpAppsMap = {};

  const forbiddenHosts = [
    'racecoursejebelali.com', 'www.racecoursejebelali.com',
    'sofiteldowntown.com', 'www.sofiteldowntown.com',
    'livelo.digitaisx.mov', 'www.livelo.digitaisx.mov',
  ];
  forbiddenHosts.forEach((host) => routingAcls.push(new Directive('acl', ['forbiddenacl', 'hdr(host)', host])));
  routingAcls.push(new Directive('acl', ['forbiddenacl', 'path_beg', '-i', '/product/litty-cat-thc-bars-1000mg']));
  routingUseBackends.push(new Directive('use_backend', ['forbidden-backend', 'if', 'forbiddenacl']));

  for (const app of appConfig) {
    if (domains.includes(app.domain)) {
      // eslint-disable-next-line no-continue
      continue;
    }
    const domainUsed = app.domain.split('.').join('');
    if (app.appName in seenApps) {
      domains.push(app.domain);
      routingAcls.push(new Directive('acl', [seenApps[app.appName], 'hdr(host)', app.domain]));
    } else if (matchRule(app.name.toLowerCase(), configGlobal.minecraftApps)) {
      // minecraftAppsMap is built for parity but never rendered (the minecraft-settings
      // path is off), so a minecraft app contributes nothing to the http frontends.
      const { port } = app;
      if (!(port in minecraftAppsMap)) minecraftAppsMap[port] = { acls: [], usebackends: [], backends: [] };
      minecraftAppsMap[port].acls = minecraftAppsMap[port].acls.concat(generateMinecraftACLs(app));
      minecraftAppsMap[port].usebackends.push(`  use_backend ${domainUsed}_tcp_backend if ${domainUsed}\n`);
      const db = generateDomainBackend(app, 'tcp').render();
      if (!minecraftAppsMap[port].backends.includes(db)) minecraftAppsMap[port].backends.push(db);
    } else {
      if (routingUseBackends.some((d) => d.args[0] === `${domainUsed}backend`)) {
        // eslint-disable-next-line no-continue
        continue;
      }
      backendSections.push(generateDomainBackend(app, 'http'));
      domains.push(app.domain);
      routingAcls.push(new Directive('acl', [domainUsed, 'hdr(host)', app.domain]));
      routingUseBackends.push(new Directive('use_backend', [`${domainUsed}backend`, 'if', domainUsed]));
      seenApps[app.appName] = domainUsed;
    }
    if (app.mode === 'tcp') {
      log.info(`TCP APP: ${app.name}`);
      const { port } = app;
      if (!(port in tcpAppsMap)) tcpAppsMap[port] = { acls: [], usebackends: [], backends: [] };
      const db = generateDomainBackend(app, 'tcp').render();
      if (!tcpAppsMap[port].usebackends.length) tcpAppsMap[port].usebackends.push(`  default_backend ${domainUsed}_tcp_backend\n`);
      if (!tcpAppsMap[port].backends.length) tcpAppsMap[port].backends.push(db);
      tcpAppsMap[port].acls = tcpAppsMap[port].acls.concat(generateMinecraftACLs(app));
      tcpAppsMap[port].acls.push(`  acl ${domainUsed} req.ssl_sni -i ${app.domain}`);
      tcpAppsMap[port].usebackends.push(`  use_backend ${domainUsed}_tcp_backend if ${domainUsed}\n`);
      if (!tcpAppsMap[port].backends.includes(db)) tcpAppsMap[port].backends.push(db);
    }
  }

  // Append the app routing to frontend wwwhttp (acls first, then use_backends).
  routingAcls.forEach((directive) => wwwhttp.push(directive));
  routingUseBackends.forEach((directive) => wwwhttp.push(directive));

  // TCP frontends (+ their backends): reuse the string builder, fold into the model.
  parse(generateAppsTCPSettings(tcpAppsMap)).sections.forEach((section) => config.sections.push(section));

  // Frontend wwwhttps: static body + the :443 bind + FDM-API routing, then the same
  // app routing as wwwhttp.
  const bindLine = `${certificatePrefix}${createCertificatesPaths(domains)}${certificatesSuffix} ${h2Suffix}`;
  const wwwhttps = parse(`${httpsPrefix}${bindLine}\n${httpsFdmApiPrefix}`).sections[0];
  routingAcls.forEach((directive) => wwwhttps.push(directive));
  routingUseBackends.forEach((directive) => wwwhttps.push(directive));
  config.sections.push(wwwhttps);

  // Backends: the app http backends, then the fixed platform backends.
  backendSections.forEach((section) => config.sections.push(section));
  [letsEncryptBackend, cloudflareFluxBackend, fdmApiBackend, forbiddenBackend]
    .forEach((text) => parse(text).sections.forEach((section) => config.sections.push(section)));

  return config.render();
}

async function writeConfig(configName, data) {
  await fs.writeFile(configName, data);
}

async function checkConfig(configName) {
  const response = await cmdAsync(`sudo haproxy -f ${configName} -c`);
  const configOK = (response.includes('Configuration file is valid') || response.includes('Warnings were found.'));
  return configOK;
}

async function cleanupBrokenCerts() {
  const certDir = `/etc/ssl/${configGlobal.certFolder}`;
  try {
    const files = await fs.readdir(certDir);
    for (const file of files) {
      const filePath = `${certDir}/${file}`;
      if (!file.endsWith('.pem')) {
        log.info(`Removing non-.pem file from cert directory: ${filePath}`);
        // eslint-disable-next-line no-await-in-loop
        await fs.unlink(filePath);
        // eslint-disable-next-line no-continue
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      const stat = await fs.stat(filePath);
      if (stat.size === 0) {
        log.info(`Removing empty cert file: ${filePath}`);
        // eslint-disable-next-line no-await-in-loop
        await fs.unlink(filePath);
      }
    }
  } catch (error) {
    log.warn(`Error cleaning cert directory: ${error.message}`);
  }
}

async function restartProxy(dataToWrite) {
  await writeConfig(TEMP_HAPROXY_CONFIG, dataToWrite);
  await cleanupBrokenCerts();
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
  // Renders one route config into its haproxy backend block (mode/balance/timeouts/
  // retries/servers), independent of the surrounding frontend and cert binds.
  generateDomainBackend,
  restartProxy,
};

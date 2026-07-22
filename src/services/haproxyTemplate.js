/* eslint-disable no-useless-escape */
/* eslint-disable no-restricted-syntax */
const configGlobal = require('config');
const fs = require('fs').promises;
const log = require('../lib/log');
const { cmdAsync, TEMP_HAPROXY_CONFIG, HAPROXY_CONFIG } = require('./constants');
const { matchRule } = require('./serviceHelper');
const { getPrimaryIP } = require('./rsync/config');
const { resolveBackendConfig } = require('./haproxy/resolveBackendConfig');
const { HaproxyConfig, Section, Directive } = require('./haproxy/configModel');

let lastHaproxyConfig;

// Shared TLS selection — the same curves/ciphers for client binds and backend servers.
const SSL_CURVES = 'X25519:prime256v1:secp384r1';
const SSL_CIPHERS = 'ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305:DHE-RSA-AES128-GCM-SHA256:DHE-RSA-AES256-GCM-SHA384';
const SSL_CIPHERSUITES = 'TLS_AES_128_GCM_SHA256:TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256';
// The two CORS response headers haproxy adds unless already present — held verbatim
// (quotes + the `unless { ... }` guard don't tokenize cleanly).
const CORS_EXPOSE_HEADERS = "http-response add-header Access-Control-Expose-Headers '*' unless { res.hdr(Access-Control-Expose-Headers) -m found }";
const CORS_ALLOW_ORIGIN = 'http-after-response add-header Access-Control-Allow-Origin "*" unless { res.hdr(Access-Control-Allow-Origin) -m found }';

// The static skeleton every generated config starts from: global tuning + TLS defaults,
// the shared `defaults` block, and the plain-http frontend (ACME/redirect setup). The
// caller appends per-app or main-LB routing to the wwwhttp frontend.
function buildBaseConfig() {
  const config = new HaproxyConfig();

  const global = config.section('global');
  if (configGlobal.cloudflare.manageapp) global.add('lua-load', '/etc/haproxy/haproxy_minecraft.lua');
  global.add('maxconn', '50000')
    .add('log', '/dev/log', 'local0', 'info', 'alert')
    .add('log', '/dev/log', 'local1', 'warning', 'alert')
    .add('chroot', '/var/lib/haproxy')
    .add('stats', 'socket', '/run/haproxy/admin.sock', 'mode', '660', 'level', 'admin', 'expose-fd', 'listeners')
    .add('stats', 'timeout', '30s')
    .add('user', 'haproxy')
    .add('group', 'haproxy')
    .add('daemon')
    .add('server-state-file', '/tmp/server-state')
    .add('ca-base', '/etc/ssl/certs')
    .add('crt-base', '/etc/ssl/private')
    .add('ssl-default-bind-curves', SSL_CURVES)
    .add('ssl-default-bind-ciphers', SSL_CIPHERS)
    .add('ssl-default-bind-ciphersuites', SSL_CIPHERSUITES)
    .add('ssl-default-bind-options', 'prefer-client-ciphers', 'ssl-min-ver', 'TLSv1.2', 'no-tls-tickets')
    .add('ssl-default-server-curves', SSL_CURVES)
    .add('ssl-default-server-ciphers', SSL_CIPHERS)
    .add('ssl-default-server-ciphersuites', SSL_CIPHERSUITES)
    .add('ssl-default-server-options', 'ssl-min-ver', 'TLSv1.2', 'no-tls-tickets')
    .comment('curl https://ssl-config.mozilla.org/ffdhe4096.txt > /etc/haproxy/dhparam')
    .add('ssl-dh-param-file', '/etc/haproxy/dhparam');

  config.section('defaults')
    .add('load-server-state-from-file', 'global')
    .add('log', 'global')
    .add('mode', 'http')
    .add('option', 'dontlognull')
    .add('timeout', 'connect', '10000')
    .add('timeout', 'client', '120000')
    .add('timeout', 'server', '120000')
    .add('maxconn', '100000')
    .add('errorfile', '400', '/etc/haproxy/errors/400.http')
    .add('errorfile', '403', '/etc/haproxy/errors/403.http')
    .add('errorfile', '408', '/etc/haproxy/errors/408.http')
    .add('errorfile', '500', '/etc/haproxy/errors/500.http')
    .add('errorfile', '502', '/etc/haproxy/errors/502.http')
    .add('errorfile', '503', '/etc/haproxy/errors/503.http')
    .add('errorfile', '504', '/etc/haproxy/errors/504.http');

  config.section('frontend', 'wwwhttp')
    .add('bind', '*:80')
    .add('option', 'forwardfor', 'except', '127.0.0.0/8')
    .add('http-request', 'add-header', 'X-Forwarded-Proto', 'http')
    .raw(CORS_EXPOSE_HEADERS)
    .raw(CORS_ALLOW_ORIGIN)
    .add('acl', 'letsencrypt-acl', 'path_beg', '/.well-known/acme-challenge/')
    .add('acl', 'cloudflare-flux-acl', 'path_beg', '/.well-known/pki-validation/')
    .add('redirect', 'scheme', 'https', 'if', '!letsencrypt-acl', '!cloudflare-flux-acl')
    .add('use_backend', 'letsencrypt-backend', 'if', 'letsencrypt-acl')
    .add('use_backend', 'cloudflare-flux-backend', 'if', 'cloudflare-flux-acl');

  return config;
}

const h2Suffix = 'alpn h2,http/1.1';

// The ACME/certbot backend target: this node's own certbot when it is the renewal
// primary, otherwise the primary's IP (computed once). Resolved at load so the error
// only logs once rather than every render.
const letsEncryptTarget = (() => {
  if (configGlobal.certRenewalPrimary) return '127.0.0.1';
  const primaryIP = getPrimaryIP();
  if (!primaryIP) {
    log.error('certRenewalPrimary is false but no primary IP found in hosts.ini. ACME challenges will fail.');
  }
  return primaryIP || '127.0.0.1';
})();

// The wwwhttps frontend's static skeleton — options/stats, the :443 TLS bind, and the
// FDM-API routing — shared by the apps and main configs. The caller appends the app or
// main routing. haproxy loads every cert in the crt directory.
function buildWwwhttpsFrontend() {
  const section = new Section('frontend', 'wwwhttps');
  section.add('option', 'http-server-close')
    .add('option', 'forwardfor', 'except', '127.0.0.0/8')
    .raw(CORS_EXPOSE_HEADERS)
    .raw(CORS_ALLOW_ORIGIN)
    .add('stats', 'enable')
    .add('stats', 'hide-version')
    .add('stats', 'uri', '/fluxstatistics')
    .raw('stats realm Flux\\ Statistics')
    .add('bind', '*:443', 'ssl', 'crt', `/etc/ssl/${configGlobal.certFolder}/`, h2Suffix)
    .add('acl', 'fdm-domain', 'hdr(host)', '-i', configGlobal.fdmAppDomain)
    .add('acl', 'fdm-api-path', 'path_beg', '/api/')
    .add('use_backend', 'fdm-api-backend', 'if', 'fdm-domain', 'fdm-api-path');
  return section;
}

// The fixed platform backends every config ends with: ACME, cloudflare validation, the
// FDM API, and the catch-all forbidden backend.
function staticBackends() {
  return [
    new Section('backend', 'letsencrypt-backend').add('server', 'letsencrypt', `${letsEncryptTarget}:8787`),
    new Section('backend', 'cloudflare-flux-backend').add('server', 'cloudflareflux', `127.0.0.1:${configGlobal.server.port}`),
    new Section('backend', 'fdm-api-backend')
      .add('http-request', 'set-path', '%[path,regsub(^/api/,/)]')
      .add('server', 'fdm-api', `127.0.0.1:${configGlobal.server.port}`),
    new Section('backend', 'forbidden-backend').add('mode', 'http').add('http-request', 'deny', 'deny_status', '403'),
  ];
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

// One TCP frontend per port (SNI-routed), plus its backend section(s). Ports 80/443
// are never forwarded. Returns the sections in render order (frontend then backends).
function generateAppsTCPSettings(tcpAppsMap) {
  const sections = [];
  for (const port of Object.keys(tcpAppsMap)) {
    if (+port === 443 || +port === 80) { // hot fix: do not forward 80 and 443
      // eslint-disable-next-line no-continue
      continue;
    }
    const portConf = tcpAppsMap[port];
    const frontend = new Section('frontend', `tcp_app_${port}`);
    frontend.add('bind', `0.0.0.0:${port}`)
      .add('mode', 'tcp')
      .add('option', 'tcplog')
      .add('option', 'tcp-check')
      .add('tcp-request', 'inspect-delay', '5s');
    if (+port === 25565) { // minecraft: route off the parsed handshake, not TLS hello
      frontend.add('tcp-request', 'content', 'lua.mc_handshake');
      frontend.add('tcp-request', 'content', 'accept', 'if', '{ var(txn.mc_proto) -m found }');
    } else {
      frontend.add('tcp-request', 'content', 'accept', 'if', '{ req_ssl_hello_type 1 }');
    }
    portConf.acls.forEach((line) => frontend.raw(line.trim()));
    portConf.usebackends.forEach((line) => frontend.raw(line.trim()));
    sections.push(frontend, ...portConf.backends);
  }
  return sections;
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

  // API backend: source-based load balancing for session persistence, failover +
  // retries, long websocket tunnels, fast health-check failure detection.
  const apiBackendSection = new Section('backend', `${apiB}backend`)
    .add('http-response', 'set-header', 'FLUXNODE', '%s')
    .add('mode', 'http')
    .add('balance', 'source')
    .add('option', 'redispatch')
    .add('retries', '3')
    .add('timeout', 'tunnel', '7200s')
    .add('timeout', 'server', '30s')
    .add('timeout', 'connect', '5s')
    .add('option', 'http-keep-alive')
    .add('no', 'option', 'httpclose')
    .add('default-server', 'check', 'inter', '10s', 'fall', '2', 'rise', '3', 'maxconn', '100');

  // Roundrobin API backend for endpoints that need random distribution.
  const apiRoundrobinSection = new Section('backend', `${apiB}roundrobinbackend`)
    .add('http-response', 'set-header', 'FLUXNODE', '%s')
    .add('http-response', 'set-header', 'X-Flux-Mode', '"Roundrobin"')
    .add('mode', 'http')
    .add('balance', 'roundrobin')
    .add('option', 'redispatch')
    .add('retries', '3')
    .add('timeout', 'tunnel', '7200s')
    .add('timeout', 'server', '120s')
    .add('timeout', 'connect', '5s')
    .add('option', 'http-keep-alive')
    .add('no', 'option', 'httpclose')
    .add('default-server', 'check', 'inter', '10s', 'fall', '2', 'rise', '3', 'maxconn', '100');

  // UI backend: balance on the real client IP (CF-Connecting-IP).
  const uiBackendSection = new Section('backend', `${uiB}backend`)
    .add('http-response', 'set-header', 'FLUXNODE', '%s')
    .add('mode', 'http')
    .add('balance', 'hdr(CF-Connecting-IP)')
    .add('option', 'redispatch')
    .add('retries', '3')
    .add('timeout', 'server', '30s')
    .add('timeout', 'connect', '5s')
    .add('default-server', 'check', 'inter', '10s', 'fall', '2', 'rise', '3', 'maxconn', '100');
  serverMapping.forEach((server) => {
    uiBackendSection.add('server', server.serverName, `${server.baseHost}:${server.uiPort}`, 'check');
    apiBackendSection.add('server', server.serverName, `${server.baseHost}:${server.apiPort}`, 'check');
    apiRoundrobinSection.add('server', server.serverName, `${server.baseHost}:${server.apiPort}`, 'check');
  });

  // Routing ACLs (endpoint stickiness/roundrobin, websocket, host -> ui/api backend).
  const routingAcls = [];
  configGlobal.haproxyRouting.mainStickyEndpoints
    .forEach((p) => routingAcls.push(new Directive('acl', ['is_sticky_endpoint', 'path_beg', p])));
  configGlobal.haproxyRouting.mainRoundrobinEndpoints
    .forEach((p) => routingAcls.push(new Directive('acl', ['is_roundrobin_endpoint', 'path_beg', p])));
  routingAcls.push(new Directive('acl', ['is_websocket', 'hdr(connection)', '-i', 'upgrade']));
  routingAcls.push(new Directive('acl', ['is_websocket_upgrade', 'hdr(upgrade)', '-i', 'websocket']));
  routingAcls.push(new Directive('acl', [uiB, 'hdr(host)', ui]));
  routingAcls.push(new Directive('acl', [apiB, 'hdr(host)', api]));
  if (uiPrimary) routingAcls.push(new Directive('acl', [uiB, 'hdr(host)', uiPrimary]));
  if (apiPrimary) routingAcls.push(new Directive('acl', [apiB, 'hdr(host)', apiPrimary]));
  routingAcls.push(new Directive('acl', [uiB, 'hdr(host)', cloudUi])); // cloud UI shares the home UI backend
  if (cloudUiPrimary) routingAcls.push(new Directive('acl', [uiB, 'hdr(host)', cloudUiPrimary]));

  const routingUseBackends = [
    new Directive('use_backend', [`${apiB}backend`, 'if', 'is_websocket', apiB]),
    new Directive('use_backend', [`${apiB}roundrobinbackend`, 'if', apiB, 'is_roundrobin_endpoint']),
    new Directive('use_backend', [`${uiB}backend`, 'if', uiB]),
    new Directive('use_backend', [`${apiB}backend`, 'if', apiB]),
  ];
  const redirectLine = 'http-request redirect code 301 location https://cloud.runonflux.com/dashboards/overview if { hdr(host) -i dashboard.zel.network }';

  // Assemble: static skeleton, both http frontends carrying the routing + redirect, then
  // the backends.
  const config = buildBaseConfig();
  const wwwhttps = buildWwwhttpsFrontend();
  [config.sections.find((s) => s.name === 'wwwhttp'), wwwhttps].forEach((frontend) => {
    routingAcls.forEach((directive) => frontend.push(directive));
    routingUseBackends.forEach((directive) => frontend.push(directive));
    frontend.raw(redirectLine);
  });
  config.sections.push(wwwhttps, uiBackendSection, apiBackendSection, apiRoundrobinSection);
  staticBackends().forEach((section) => config.sections.push(section));

  return config.render();
}

// appConfig is an array of object of domain, port, ips
function createAppsHaproxyConfig(appConfig) {
  // Static skeleton: global, defaults, and frontend wwwhttp (with its acme/redirect
  // setup), folded into the model from the existing template.
  const config = buildBaseConfig();
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

  configGlobal.haproxyRouting.forbiddenHosts
    .forEach((host) => routingAcls.push(new Directive('acl', ['forbiddenacl', 'hdr(host)', host])));
  configGlobal.haproxyRouting.forbiddenPaths
    .forEach((p) => routingAcls.push(new Directive('acl', ['forbiddenacl', 'path_beg', '-i', p])));
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
      if (!(port in tcpAppsMap)) {
        tcpAppsMap[port] = {
          acls: [], usebackends: [], backends: [], seenBackends: new Set(),
        };
      }
      const tcp = tcpAppsMap[port];
      const tcpBackend = generateDomainBackend(app, 'tcp');
      const key = tcpBackend.render();
      if (!tcp.usebackends.length) tcp.usebackends.push(`default_backend ${domainUsed}_tcp_backend`);
      if (!tcp.seenBackends.has(key)) { tcp.seenBackends.add(key); tcp.backends.push(tcpBackend); }
      tcp.acls = tcp.acls.concat(generateMinecraftACLs(app));
      tcp.acls.push(`acl ${domainUsed} req.ssl_sni -i ${app.domain}`);
      tcp.usebackends.push(`use_backend ${domainUsed}_tcp_backend if ${domainUsed}`);
    }
  }

  // Append the app routing to frontend wwwhttp (acls first, then use_backends).
  routingAcls.forEach((directive) => wwwhttp.push(directive));
  routingUseBackends.forEach((directive) => wwwhttp.push(directive));

  // TCP frontends (+ their backends).
  generateAppsTCPSettings(tcpAppsMap).forEach((section) => config.sections.push(section));

  // Frontend wwwhttps: the shared static skeleton, then the same app routing as wwwhttp.
  const wwwhttps = buildWwwhttpsFrontend();
  routingAcls.forEach((directive) => wwwhttps.push(directive));
  routingUseBackends.forEach((directive) => wwwhttps.push(directive));
  config.sections.push(wwwhttps);

  // Backends: the app http backends, then the fixed platform backends.
  backendSections.forEach((section) => config.sections.push(section));
  staticBackends().forEach((section) => config.sections.push(section));

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

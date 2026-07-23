// Version-blind replacement for domainService.addConfigurations: turns a resolved
// DeploymentSpec + backend IPs into the haproxy route configs the renderer consumes,
// sourced from the spec's loadBalancing routes rather than raw compose. Each route
// config maps one domain to a backend (ips:port) plus its tuning. Every version flows
// through one path — legacy apps route every port
// (flux-spec synthesizes a loadBalancing entry per port), v9 apps route the ports
// their owner configured. flux-spec hands back one flat route per (component, port)
// with custom domains already split into a clean array, so this reads routes rather
// than walking components → loadBalancing by hand.
//
// The output matches addConfigurations field-for-field so the existing renderer
// produces byte-identical config; the platform FQDN and custom-domain expansion
// (www./test. variants, de-duplication) reproduce the legacy behavior exactly.
const config = require('config');
const { resolveCustomConfig } = require('../application/custom');

// Strip protocol prefixes and characters HAProxy can't carry in a host-header
// ACL; the dot is kept.
const sanitizeDomain = (domain) => domain
  .replace('https://', '')
  .replace('http://', '')
  .replace(/[&/\\#,+()$~%'":*?<>{}]/g, '');

// `ownsDomain(domain)` decides whether this app may serve a custom domain (another
// live app may own it — first-registrant-wins). Defaults to allow-all so callers that
// don't arbitrate ownership (e.g. the characterization harness) get every route.
// `drainingIps` are backends the platform reports shutting down: rendered in
// maintenance rather than dropped, so they stay visible while taking no traffic. Kept
// apart from `appIps` so the in-rotation count and ordering are unaffected.
function buildRouteConfigs(deployment, appName, appIps, isActiveStandby, syncFirst, ownsDomain = () => true, drainingIps = []) {
  const configs = [];
  const platformSuffix = `${config.appSubDomain}.${config.mainDomain}`;
  const lowerName = appName.toLowerCase();
  // The platform subdomain guard the legacy custom-domain filter uses.
  const platformToken = `${config.appSubDomain}.${config.mainDomain.split('.')[0]}`;
  const platformTokenNoDot = `${config.appSubDomain}${config.mainDomain.split('.')[0]}`;

  const has = (domain) => configs.find((entry) => entry.domain === domain);

  // eslint-disable-next-line no-restricted-syntax
  for (const route of deployment.routes()) {
    const { componentName, hostPort } = route;
    const backendName = `${appName}_${componentName}_${hostPort}`;
    const customConfig = resolveCustomConfig(appName, componentName, hostPort, isActiveStandby);
    // v9 routes carry owner-declared LB tunables off the resolved loadBalancing entry;
    // legacy routes carry none (balancing stays undefined), so the renderer takes the
    // legacy path. resolveBackendConfig reads these to render version-blind.
    const v9Tuning = route.balancing === undefined ? {} : {
      balancing: route.balancing,
      timeouts: route.timeouts,
      retries: route.retries,
      stickySessions: route.stickySessions,
      healthCheck: route.healthCheck,
      backendTls: route.backendTls,
      maxConnectionsPerServer: route.maxConnectionsPerServer,
    };
    // Edge exposure (scheme + managed cert) applies to the owner's custom domains only;
    // a v9 route carries a scheme, legacy carries none. Platform FQDNs never get this —
    // FDM owns app2.runonflux.io, so those always terminate + redirect + cert.
    const exposure = route.scheme === undefined ? {} : {
      scheme: route.scheme,
      managedCertificates: route.managedCertificates,
    };
    const base = {
      name: appName,
      appName: backendName,
      port: hostPort,
      ips: appIps,
      drainingIps,
      syncFirst,
      ...customConfig,
      ...v9Tuning,
      timeout: null,
    };

    // Platform FQDN for this port.
    configs.push({ ...base, domain: `${lowerName}_${hostPort}.${platformSuffix}` });

    // Owner custom domains: flux-spec has already split them into individual, trimmed
    // domains for every version, so we just sanitize each for the ACL.
    // eslint-disable-next-line no-restricted-syntax
    for (const customDomain of route.customDomains || []) {
      let portDomain = sanitizeDomain(customDomain);
      // Drop the whole domain (and its www./test. variants) if this app doesn't own
      // it — checked before www-stripping, on the domain as registered.
      if (!ownsDomain(portDomain)) {
        // eslint-disable-next-line no-continue
        continue;
      }
      if (portDomain.includes('www.')) {
        [, portDomain] = portDomain.split('www.');
      }
      if (
        portDomain
        && portDomain.includes('.')
        && portDomain.length >= 3
        && !portDomain.toLowerCase().includes(platformToken)
        && !has(portDomain)
        && !portDomain.includes(platformTokenNoDot)
      ) {
        if (!has(portDomain.toLowerCase())) configs.push({ ...base, ...exposure, domain: portDomain });
        const www = `www.${portDomain.toLowerCase()}`;
        if (!has(www)) configs.push({ ...base, ...exposure, domain: www });
        const test = `test.${portDomain.toLowerCase()}`;
        if (!has(test)) configs.push({ ...base, ...exposure, domain: test });
      }
    }
  }

  // Main domain — alias to the first route's backend.
  const mainDomain = `${lowerName}.${platformSuffix}`;
  if (!has(mainDomain) && configs.length) {
    const first = configs[0];
    configs.push({
      name: appName,
      appName: first.appName,
      domain: mainDomain,
      port: first.port,
      ips: appIps,
      drainingIps,
      syncFirst,
      ...resolveCustomConfig(appName, '', '', isActiveStandby),
    });
  }

  return configs;
}

module.exports = { buildRouteConfigs };

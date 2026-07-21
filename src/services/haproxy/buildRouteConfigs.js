// Version-blind replacement for domainService.addConfigurations: turns a resolved
// DeploymentSpec + backend IPs into the haproxy backend-config entries (the "bag"
// the renderer consumes), sourced from the spec's loadBalancing routes rather than
// raw compose. Every version flows through one path — legacy apps route every port
// (flux-spec synthesizes a loadBalancing entry per port), v9 apps route the ports
// their owner configured.
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

function buildRouteConfigs(deployment, appName, appIps, isActiveStandby, syncFirst) {
  const configs = [];
  const platformSuffix = `${config.appSubDomain}.${config.mainDomain}`;
  const lowerName = appName.toLowerCase();
  // The platform subdomain guard the legacy custom-domain filter uses.
  const platformToken = `${config.appSubDomain}.${config.mainDomain.split('.')[0]}`;
  const platformTokenNoDot = `${config.appSubDomain}${config.mainDomain.split('.')[0]}`;

  const has = (domain) => configs.find((entry) => entry.domain === domain);

  // eslint-disable-next-line no-restricted-syntax
  for (const [componentName, component] of Object.entries(deployment.components)) {
    // eslint-disable-next-line no-restricted-syntax
    for (const lb of Object.values(component.loadBalancing || {})) {
      const { hostPort } = lb;
      const bagAppName = `${appName}_${componentName}_${hostPort}`;
      const customConfig = resolveCustomConfig(appName, componentName, hostPort, isActiveStandby);
      const base = {
        name: appName,
        appName: bagAppName,
        port: hostPort,
        ips: appIps,
        syncFirst,
        ...customConfig,
        timeout: null,
      };

      // Platform FQDN for this port.
      configs.push({ ...base, domain: `${lowerName}_${hostPort}.${platformSuffix}` });

      // Owner custom domains: legacy carries the raw (possibly comma-joined) string
      // in a single customDomains element; v9 carries a proper array. Splitting on
      // comma handles both.
      // eslint-disable-next-line no-restricted-syntax
      for (const rawDomain of lb.customDomains || []) {
        // eslint-disable-next-line no-restricted-syntax
        for (const entry of rawDomain.split(',')) {
          let portDomain = sanitizeDomain(entry);
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
            if (!has(portDomain.toLowerCase())) configs.push({ ...base, domain: portDomain });
            const www = `www.${portDomain.toLowerCase()}`;
            if (!has(www)) configs.push({ ...base, domain: www });
            const test = `test.${portDomain.toLowerCase()}`;
            if (!has(test)) configs.push({ ...base, domain: test });
          }
        }
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
      syncFirst,
      ...resolveCustomConfig(appName, '', '', isActiveStandby),
    });
  }

  return configs;
}

module.exports = { buildRouteConfigs };

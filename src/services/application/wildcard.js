const config = require('config');

const label = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const domainPattern = new RegExp(`^(?:${label}\\.)+${label}$`);
// Generated per-port FDM hostnames can contain underscores.
const targetPattern = /^[a-z0-9_-]+(?:\.[a-z0-9_-]+)+$/;

function getWildcardAppRoutes(input = config.wildcardAppRoutes || []) {
  if (!Array.isArray(input)) throw new Error('wildcardAppRoutes must be an array');
  const routes = input.map((route) => {
    if (!route || typeof route.domain !== 'string' || typeof route.appName !== 'string' || typeof route.targetDomain !== 'string') {
      throw new Error('Each wildcardAppRoutes entry requires domain, appName and targetDomain');
    }
    const domain = route.domain.toLowerCase();
    const appName = route.appName.toLowerCase();
    const targetDomain = route.targetDomain.toLowerCase();
    if (domain.length > 189 || !domainPattern.test(domain) || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(appName)
      || targetDomain.length > 253 || !targetPattern.test(targetDomain)) {
      throw new Error('Invalid wildcardAppRoutes domain, appName or targetDomain');
    }
    return { domain, appName, targetDomain };
  });
  routes.forEach((route, index) => {
    if (routes.some((other, otherIndex) => otherIndex < index
      && (route.domain === other.domain || route.domain.endsWith(`.${other.domain}`) || other.domain.endsWith(`.${route.domain}`)))) {
      throw new Error('wildcardAppRoutes namespaces must not overlap');
    }
    if (routes.some((other) => route.targetDomain === other.domain || route.targetDomain.endsWith(`.${other.domain}`))) {
      throw new Error('wildcardAppRoutes targets must be outside reserved namespaces');
    }
  });
  return routes;
}

// The entire namespace is operator-owned, including the apex and deeper names
// that a one-label TLS wildcard does not cover. Never provision DNS/certs or
// exact-host routes there from an application's custom-domain claims.
function isWildcardAppDomain(domain, routes = getWildcardAppRoutes()) {
  const host = domain.toLowerCase().replace(/\.$/, '');
  return routes.some((route) => host === route.domain || host.endsWith(`.${route.domain}`));
}

module.exports = { getWildcardAppRoutes, isWildcardAppDomain };

const config = require('config');
const fs = require('fs').promises;
const { X509Certificate, createPrivateKey } = require('crypto');
const log = require('../../lib/log');

const label = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const domainPattern = new RegExp(`^(?:${label}\\.)+${label}$`);

function parseWildcardRoutes(input) {
  if (!Array.isArray(input)) throw new Error('wildcardAppRoutes must be an array');
  const appZone = `.${config.appSubDomain}.${config.mainDomain}`.toLowerCase();
  const routes = input.map((route) => {
    if (!route || typeof route.domain !== 'string' || typeof route.targetDomain !== 'string') {
      throw new Error('Each wildcardAppRoutes entry requires domain and targetDomain');
    }
    const domain = route.domain.toLowerCase();
    const targetDomain = route.targetDomain.toLowerCase();
    // Only generated app endpoints can be targets: custom domain claims are
    // excluded from this zone before the HTTP backend list is constructed.
    if (domain.length > 189 || !domainPattern.test(domain) || targetDomain.length > 253
      || !targetDomain.endsWith(appZone) || !/^[a-z0-9][a-z0-9_-]*$/.test(targetDomain.slice(0, -appZone.length))) {
      throw new Error('Invalid wildcardAppRoutes domain or generated targetDomain');
    }
    return { domain, targetDomain };
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

// Static operator mistakes fail at startup, never during an app update pass.
const wildcardRoutes = parseWildcardRoutes(config.wildcardAppRoutes || []);
function getWildcardAppRoutes() { return wildcardRoutes; }

// Reservation is independent of certificate availability, including the apex.
function isWildcardAppDomain(domain, routes = wildcardRoutes) {
  const host = domain.toLowerCase().replace(/\.$/, '');
  return routes.some((route) => host === route.domain || host.endsWith(`.${route.domain}`));
}

async function certificateFingerprint(domain, now = Date.now(), directory = `/etc/ssl/${config.certFolder}`) {
  try {
    const pem = await fs.readFile(`${directory}/${domain}.pem`);
    const cert = new X509Certificate(pem);
    // Checking a concrete hostname alone would also accept a single-site cert.
    // checkHost with the wildcard itself requires coverage of the namespace.
    if (Date.parse(cert.validFrom) > now || Date.parse(cert.validTo) <= now
      || !cert.checkHost(`*.${domain}`) || !cert.checkPrivateKey(createPrivateKey(pem))) return null;
    return cert.fingerprint256;
  } catch (error) {
    return null;
  }
}

const lastServable = new Map();
async function getServableWildcardRoutes(routes = wildcardRoutes, check = certificateFingerprint) {
  const checked = await Promise.all(routes.map(async (route) => {
    const fingerprint = await check(route.domain);
    if (lastServable.get(route.domain) !== Boolean(fingerprint)) {
      log.warn(`Wildcard namespace ${route.domain}: ${fingerprint ? 'certificate ready' : 'dormant; valid wildcard certificate and matching key required'}`);
      lastServable.set(route.domain, Boolean(fingerprint));
    }
    return fingerprint ? { ...route, certificateFingerprint: fingerprint } : null;
  }));
  return checked.filter(Boolean);
}

function createRoutePublication(getRoutes = getServableWildcardRoutes) {
  let published = '[]';
  return {
    async changed() {
      return JSON.stringify(await getRoutes()) !== published;
    },
    async publish(callback) {
      const routes = await getRoutes();
      const result = await callback(routes);
      published = JSON.stringify(routes);
      return result;
    },
  };
}

module.exports = {
  parseWildcardRoutes,
  getWildcardAppRoutes,
  isWildcardAppDomain,
  certificateFingerprint,
  getServableWildcardRoutes,
  createRoutePublication,
};

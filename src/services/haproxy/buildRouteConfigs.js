// Version-blind replacement for domainService.addConfigurations: turns resolved
// DeploymentSpecs + live backends into the haproxy route configs the renderer consumes,
// sourced from the spec's loadBalancing routes rather than raw compose. Each route
// config maps one domain to a backend (servers + tuning). Every version flows through
// one path — legacy apps route every port (flux-spec synthesizes a loadBalancing entry
// per port), v9 apps route the ports their owner configured. flux-spec hands back one
// flat route per (component, port) with custom domains already split into a clean array,
// so this reads routes rather than walking components → loadBalancing by hand.
//
// PER REPLICA. A named replica's effective component is the canonical component deep-
// merged with that replica's override entry — a general merge, so ANY component field
// can in principle differ per replica. Today's schema allowlists only ports.hostPort and
// env, but that is validation policy, not structure ("what is overridable is validation
// policy, not schema surgery"), and it can widen without any structural change. So this
// takes a resolved DeploymentSpec PER REPLICA and reads each replica's own routes rather
// than assuming a shared route set with per-replica ports. Replicas converging on the
// same domain merge their servers into one backend; if they disagree on that domain's
// tuning, the first replica wins and the conflict is reported rather than silently
// rendering one replica's view for all.
//
// The output matches addConfigurations field-for-field so the existing renderer produces
// byte-identical config; the platform FQDN and custom-domain expansion (www./test.
// variants, de-duplication) reproduce the legacy behavior exactly.
const config = require('config');
const { resolveCustomConfig } = require('../application/custom');

// Strip protocol prefixes and characters HAProxy can't carry in a host-header
// ACL; the dot is kept.
const sanitizeDomain = (domain) => domain
  .replace('https://', '')
  .replace('http://', '')
  .replace(/[&/\\#,+()$~%'":*?<>{}]/g, '');

// Route fields that describe the BACKEND, which every replica of a route shares. A
// replica may legitimately differ on hostPort — that is the per-replica binding, and the
// reason this machinery exists — but if it differs on any of these, the backend cannot
// represent both and one replica's view would silently stand for all. Not currently
// reachable: the override allowlist stops at ports.hostPort and env. It becomes reachable
// the moment that policy widens, which is exactly when silence would be worst.
const SHARED_ROUTE_FIELDS = [
  'provider', 'mode', 'balancing', 'timeouts', 'retries', 'stickySessions',
  'healthCheck', 'backendTls', 'maxConnectionsPerServer', 'scheme',
  'managedCertificates', 'customDomains',
];

function conflictingFields(existing, candidate) {
  return SHARED_ROUTE_FIELDS.filter(
    (field) => JSON.stringify(existing[field]) !== JSON.stringify(candidate[field]),
  );
}

/**
 * @param {Map<string|null, Object>} deployments replica name → its resolved
 *   DeploymentSpec; the `null` key is the declared view used by loose (unnamed)
 *   instances, which is every legacy and every unpinned app.
 * @param {string} appName
 * @param {Array<{ip: string, replica: (string|null), draining: boolean}>} backends live
 *   backends in rotation order, draining ones last. One entry per running instance, so a
 *   node hosting two co-located replicas appears twice.
 * @param {boolean} isActiveStandby
 * @param {boolean} syncFirst
 * @param {Function} [ownsDomain] decides whether this app may serve a custom domain
 *   (another live app may own it — first-registrant-wins). Defaults to allow-all so
 *   callers that don't arbitrate ownership (e.g. the characterization harness) get
 *   every route.
 * @param {Function} [onConflict] reports replicas disagreeing on a shared domain
 */
function buildRouteConfigs(
  deployments,
  appName,
  backends,
  isActiveStandby,
  syncFirst,
  ownsDomain = () => true,
  onConflict = () => {},
) {
  const configs = [];
  const platformSuffix = `${config.appSubDomain}.${config.mainDomain}`;
  const lowerName = appName.toLowerCase();
  // The platform subdomain guard the legacy custom-domain filter uses.
  const platformToken = `${config.appSubDomain}.${config.mainDomain.split('.')[0]}`;
  const platformTokenNoDot = `${config.appSubDomain}${config.mainDomain.split('.')[0]}`;

  const has = (domain) => configs.find((entry) => entry.domain === domain);

  // Identity — the domains an app answers on, its backend names and its tuning — comes
  // from the DECLARED view, never from a replica. The platform FQDN embeds the host port
  // (`app_31000.app2...`), and a replica may bind a different one; keying identity off
  // the replica would publish a separate public domain per replica instead of one
  // load-balanced across them. A replica varies only where its server points.
  const declared = deployments.get(null);
  if (!declared) return configs;

  // A replica's own view of one declared route, matched on (component, port name) — the
  // identity that survives a host-port override.
  const routeFor = (deployment, componentName, portKey) => (
    deployment === declared
      ? null
      : deployment.routes().find((r) => r.componentName === componentName && r.portKey === portKey)
  );
  // The node addresses in rotation, de-duplicated: co-located replicas share one node,
  // and this list answers "where does this app run" (the /appips projection), not "what
  // servers does haproxy get" — that is `servers`.
  const appIps = [...new Set(backends.filter((b) => !b.draining).map((b) => b.ip))];

  // Replicas in the order they first appear in rotation, so the emitted server order
  // follows the backend ordering resolveBackends decided.
  const replicaOrder = [...new Set(backends.map((b) => b.replica ?? null))];

  const seen = (domain) => Boolean(has(domain));

  // eslint-disable-next-line no-restricted-syntax
  for (const route of declared.routes()) {
    const { componentName, portKey, hostPort } = route;
    // Every replica's servers for this route, each on the host port ITS deployment
    // resolved. Replicas keep the rotation order resolveBackends decided.
    const servers = [];
    // eslint-disable-next-line no-restricted-syntax
    for (const replica of replicaOrder) {
      const deployment = deployments.get(replica);
      // A replica with no resolved deployment cannot be routed; skip rather than fall
      // back to the declared view, which would route it on a sibling's ports.
      // eslint-disable-next-line no-continue
      if (!deployment) continue;
      const replicaRoute = routeFor(deployment, componentName, portKey);
      // A replica that does not expose this port contributes no server to it.
      // eslint-disable-next-line no-continue
      if (replica !== null && !replicaRoute) continue;
      const effective = replicaRoute || route;
      const differing = conflictingFields(route, effective);
      if (differing.length) onConflict(`${componentName}/${portKey}`, differing, replica);
      backends
        .filter((b) => (b.replica ?? null) === replica)
        .forEach((b) => servers.push({
          ip: b.ip, hostPort: effective.hostPort, replica, draining: b.draining,
        }));
    }

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
      syncFirst,
      ...customConfig,
      ...v9Tuning,
      timeout: null,
    };
    // Each domain gets its own copy: one route feeds the platform FQDN plus a bare
    // custom domain and its www./test. variants, and a shared array would alias them.
    const serversFor = () => servers.map((s) => ({ ...s }));

    // Platform FQDN for this port.
    configs.push({ ...base, domain: `${lowerName}_${hostPort}.${platformSuffix}`, servers: serversFor() });

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
        && !seen(portDomain)
        && !portDomain.includes(platformTokenNoDot)
      ) {
        const exposed = { ...base, ...exposure };
        if (!seen(portDomain.toLowerCase())) configs.push({ ...exposed, domain: portDomain, servers: serversFor() });
        const www = `www.${portDomain.toLowerCase()}`;
        if (!seen(www)) configs.push({ ...exposed, domain: www, servers: serversFor() });
        const test = `test.${portDomain.toLowerCase()}`;
        if (!seen(test)) configs.push({ ...exposed, domain: test, servers: serversFor() });
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
      servers: [...first.servers],
      syncFirst,
      ...resolveCustomConfig(appName, '', '', isActiveStandby),
    });
  }

  return configs;
}

module.exports = { buildRouteConfigs };

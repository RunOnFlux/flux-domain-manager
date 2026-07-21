// Turn a v9 spec + its location rows into the HTTP backends to render.
//
// One backend per component port that declares a (haproxy, http) load balancer —
// ports/components without one, and tcp/powerdns entries, are skipped (LB-intent
// gating). Each backend's servers are the app's location rows resolved to their
// per-replica effective host port, so co-located replicas get distinct-named
// servers pointing at distinct ports (no duplicate server lines).
//
// locationRows: [{ ip, replica }] — replica null/absent for a loose instance.
const config = require('config');
const { resolveDeployment } = require('../flux/specLibs');

// Platform FQDN for a component port, plus any owner custom domains.
function domainsFor(appName, portName, lb) {
  const platform = `${appName.toLowerCase()}_${portName}.${config.appSubDomain}.${config.mainDomain}`;
  return [platform, ...(lb.customDomains || [])];
}
const backendNameFor = (domain) => `${domain.split('.').join('')}backend`;
// host:effectivePort is unique across nodes (differ by host) and across co-located
// replicas (differ by port) — the property that kills duplicate server names.
const serverName = (host, port) => `${host}:${port}`;

async function buildHttpBackends(spec, locationRows) {
  const declared = await resolveDeployment(spec, null);

  // Resolve each distinct replica view once.
  const depCache = new Map([['', declared]]);
  const depFor = async (replica) => {
    const key = replica || '';
    if (!depCache.has(key)) depCache.set(key, await resolveDeployment(spec, replica));
    return depCache.get(key);
  };

  const backends = [];
  for (const [compName, comp] of Object.entries(declared.components)) {
    if (!comp.loadBalancing) continue;
    for (const [portName, lb] of Object.entries(comp.loadBalancing)) {
      if (lb.provider !== 'haproxy' || lb.mode !== 'http') continue;

      const servers = [];
      for (const row of locationRows) {
        // eslint-disable-next-line no-await-in-loop
        const dep = await depFor(row.replica);
        const port = dep.getComponent(compName).loadBalancing[portName].hostPort;
        servers.push({ name: serverName(row.ip, port), host: row.ip, port });
      }

      const domains = domainsFor(spec.name, portName, lb);
      backends.push({ backendName: backendNameFor(domains[0]), domains, servers, lb });
    }
  }
  return backends;
}

module.exports = { buildHttpBackends };

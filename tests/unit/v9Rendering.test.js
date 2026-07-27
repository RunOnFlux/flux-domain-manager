// End-to-end backend rendering, version-blind. A spec flows through the same pipeline
// regardless of version (deserialize -> resolveDeployment -> buildRouteConfigs ->
// generateDomainBackend); resolveBackendConfig collapses the legacy-vs-v9 trichotomy at
// one point and never inspects a version. So the helper here takes ANY spec — a legacy
// compose object or a v9 wire — and renders it through one path. The legacy `ssl` case and
// the v9 `backendTls` case land on the same `ssl verify none` server directive from
// different owner-facing fields, which is exactly the collapse we want to lock.
const chai = require('chai');
const { load } = require('@runonflux/flux-spec-cjs');
const specLibs = require('../../src/services/flux/specLibs');
const { buildRouteConfigs } = require('../../src/services/haproxy/buildRouteConfigs');
const { looseBackends, looseDeployments } = require('./fixtures/renderPipeline');
const { generateDomainBackend } = require('../../src/services/haproxyTemplate');

const { expect } = chai;

const MULTI_NODE_IPS = ['144.76.10.20:16127', '167.86.90.30:16127'];

// A v9 submission carrying the given loadBalancing tunables.
const v9Submission = (lb) => ({
  version: 9,
  name: 'shop',
  description: 'x',
  owner: '16dNCFf7nR3nx5iwn2RQMBw6KcJXkE3JC1',
  ttl: 2592000,
  instances: 1,
  contacts: { email: ['a@b.com'] },
  components: {
    web: {
      name: 'web',
      description: 'x',
      image: 'nginx:latest',
      cpu: 0.5,
      memory: 300,
      rootFsGb: 2,
      persistentStorage: { sizeGb: 10, mounts: { '/data': { source: 'data', destination: '/data' } } },
      ports: { http: { containerPort: 80, hostPort: 31000 } },
      loadBalancing: { http: { provider: 'haproxy', mode: 'http', ...lb } },
    },
  },
});

async function v9Wire(lb) {
  const { FluxAppSpecV9 } = await load();
  return FluxAppSpecV9.fromSubmission(v9Submission(lb)).serialize();
}

// A legacy (v8 compose) spec. Its name drives the name-based `ssl` override in
// resolveCustomConfig ('trilium' -> ssl:true), which is how a legacy app gets backend TLS
// — no loadBalancing block, no version check, the same resolveCustomConfig every version
// looks up.
const legacySslSpec = () => ({
  version: 8,
  name: 'trilium',
  description: 'x',
  owner: '19z6SjrVrWqBTLiCXWLRjcu9ydnzWNz3UD',
  compose: [{
    name: 'app',
    description: 'app',
    repotag: 'nginx:latest',
    ports: [31000],
    domains: [''],
    environmentParameters: [],
    commands: [],
    containerPorts: [80],
    containerData: '/data',
    cpu: 0.1,
    ram: 100,
    hdd: 1,
    repoauth: '',
  }],
  instances: 3,
  contacts: [],
  geolocation: [],
  expire: 88000,
  nodes: [],
  staticip: false,
});

// One path for every version: a legacy object or a v9 wire, both deserialized, resolved
// and rendered identically. The app name comes off the spec, so the platform backend is
// found the same way regardless of shape.
async function renderBackend(spec) {
  const dep = await specLibs.resolveDeployment(await specLibs.deserialize(spec), null);
  const { name } = spec;
  const routeConfigs = buildRouteConfigs(looseDeployments(dep), name, looseBackends(MULTI_NODE_IPS), false, false);
  const platform = routeConfigs.find((c) => c.domain.startsWith(`${name.toLowerCase()}_`));
  return generateDomainBackend(platform, 'http').render();
}

describe('backend rendering (end-to-end, version-blind)', () => {
  it('renders v9 owner tunables (balance, cookie, probe, timeouts, retries, server line)', async () => {
    const backend = await renderBackend(await v9Wire({
      balancing: 'leastconn',
      maxConnectionsPerServer: 500,
      timeouts: { server: '90s' },
      stickySessions: { cookieName: 'MYSESS' },
      healthCheck: { path: '/health' },
      backendTls: { verify: 'none' },
    }));
    expect(backend).to.include('\n  balance leastconn');
    expect(backend).to.include('\n  cookie MYSESS insert indirect nocache maxidle 30m maxlife 8h');
    expect(backend).to.include('\n  option httpchk GET /health');
    expect(backend).to.include('\n  http-check expect status 200-399');
    expect(backend).to.include('\n  timeout connect 5s');
    expect(backend).to.include('\n  timeout server 90s');
    expect(backend).to.include('\n  timeout tunnel 3600s');
    expect(backend).to.include('\n  retries 3');
    expect(backend).to.include('\n  option redispatch');
    expect(backend).to.include('\n  server 144.76.10.20:16127 144.76.10.20:31000 check inter 5s rise 2 fall 3 maxconn 500 ssl verify none cookie 144.76.10.20:16127');
    // The shared frontend serves every app, so the per-app http-request timeout is
    // backend-scoped (httpRequest defaults to 10s here).
    expect(backend).to.include('\n  timeout http-request 10s');
  });

  // The collapse point in one assertion: legacy `ssl` (name-driven) and v9 `backendTls`
  // both resolve to the same server directive through the same helper. If a version gate
  // ever crept into resolveServerSsl, exactly one of these would drift.
  it('renders backend TLS identically from the legacy ssl flag and the v9 backendTls toggle', async () => {
    const legacy = await renderBackend(legacySslSpec());
    const v9 = await renderBackend(await v9Wire({ balancing: 'roundrobin', backendTls: { verify: 'none' } }));
    expect(legacy).to.include(' ssl verify none');
    expect(v9).to.include(' ssl verify none');
  });

  it('omits the cookie, probe and TLS when the v9 toggles are off', async () => {
    const backend = await renderBackend(await v9Wire({ balancing: 'roundrobin' }));
    expect(backend).to.include('\n  balance roundrobin');
    expect(backend).to.not.include('cookie');
    expect(backend).to.not.include('option httpchk');
    expect(backend).to.not.include('ssl verify');
    expect(backend).to.include('maxconn 2000'); // the v9 default
  });
});

// End-to-end: a v9 spec's owner-declared loadBalancing tunables flow through the
// version-blind pipeline (deserialize -> resolveDeployment -> buildRouteConfigs ->
// generateDomainBackend) into the haproxy backend block. Legacy specs render the same
// as before (covered by the characterization golden); this locks the v9 path.
const chai = require('chai');
const { load } = require('@runonflux/flux-spec-cjs');
const specLibs = require('../../src/services/flux/specLibs');
const { buildRouteConfigs } = require('../../src/services/haproxy/buildRouteConfigs');
const { looseBackends, looseDeployments } = require('./fixtures/renderPipeline');
const { generateDomainBackend } = require('../../src/services/haproxyTemplate');

const { expect } = chai;

const submission = (lb) => ({
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

async function renderV9Backend(lb) {
  const { FluxAppSpecV9 } = await load();
  const wire = FluxAppSpecV9.fromSubmission(submission(lb)).serialize();
  const dep = await specLibs.resolveDeployment(await specLibs.deserialize(wire), null);
  const routeConfigs = buildRouteConfigs(looseDeployments(dep), 'shop', looseBackends(['144.76.10.20:16127', '167.86.90.30:16127']), false, false);
  const platform = routeConfigs.find((c) => c.domain.startsWith('shop_'));
  return generateDomainBackend(platform, 'http').render();
}

describe('v9 loadBalancing rendering (end-to-end)', () => {
  it('renders owner tunables (balance, cookie, probe, timeouts, retries, server line)', async () => {
    const backend = await renderV9Backend({
      balancing: 'leastconn',
      maxConnectionsPerServer: 500,
      timeouts: { server: '90s' },
      stickySessions: { cookieName: 'MYSESS' },
      healthCheck: { path: '/health' },
      backendTls: { verify: 'none' },
    });
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

  it('omits the cookie, probe and TLS when the v9 toggles are off', async () => {
    const backend = await renderV9Backend({ balancing: 'roundrobin' });
    expect(backend).to.include('\n  balance roundrobin');
    expect(backend).to.not.include('cookie');
    expect(backend).to.not.include('option httpchk');
    expect(backend).to.not.include('ssl verify');
    expect(backend).to.include('maxconn 2000'); // the v9 default
  });
});

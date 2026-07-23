// A backend the platform reports draining is rendered in maintenance rather than
// dropped from the config: haproxy keeps the server slot (so it stays visible on the
// stats page) but sends it nothing. Version-blind — drain state rides the location row
// from flux-shutdownd -> fluxos and is independent of the spec version, so legacy and
// v9 both render it.
//
// Traffic behaviour is unchanged either way: FDM reloads over a config with
// `expose-fd listeners`, so the old worker finishes in-flight requests whether a
// removed server is deleted or disabled. This locks the rendering, not a routing change.
const chai = require('chai');
const { load } = require('@runonflux/flux-spec-cjs');
const specLibs = require('../../src/services/flux/specLibs');
const { buildRouteConfigs } = require('../../src/services/haproxy/buildRouteConfigs');
const { looseBackends, looseDeployments } = require('./fixtures/renderPipeline');
const { generateDomainBackend } = require('../../src/services/haproxyTemplate');

const { expect } = chai;

const ACTIVE = ['144.76.10.20:16127', '167.86.90.30:16127'];
const DRAINING = ['135.148.60.40:16127'];

const v8spec = (containerData = '/data') => ({
  version: 8,
  name: 'drainapp',
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
    containerData,
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

const v9submission = {
  version: 9,
  name: 'drainapp',
  description: 'x',
  owner: '16dNCFf7nR3nx5iwn2RQMBw6KcJXkE3JC1',
  ttl: 2592000,
  instances: 3,
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
      loadBalancing: { http: { provider: 'haproxy', mode: 'http' } },
    },
  },
};

// Render the platform-FQDN backend for a spec with the given in-rotation and draining
// backends, the way the routing loop assembles it.
async function render(spec, appIps, drainingIps, syncFirst = false) {
  const dep = await specLibs.resolveDeployment(await specLibs.deserialize(spec), null);
  const routeConfigs = buildRouteConfigs(looseDeployments(dep), 'drainapp', looseBackends(appIps, drainingIps), false, syncFirst);
  const platform = routeConfigs.find((c) => c.domain.startsWith('drainapp_'));
  return generateDomainBackend(platform, 'http').render();
}

const serverLines = (text) => text.split('\n').filter((l) => l.trim().startsWith('server '));

describe('draining backends render in maintenance', () => {
  it('legacy: the draining backend keeps its server line, marked disabled', async () => {
    const lines = serverLines(await render(v8spec(), ACTIVE, DRAINING));
    expect(lines).to.have.lengthOf(3);
    expect(lines.filter((l) => l.includes('disabled'))).to.have.lengthOf(1);
    expect(lines[2]).to.contain('135.148.60.40:16127');
    expect(lines[2]).to.contain('disabled');
  });

  it('v9: same, on the v9 server-line shape', async () => {
    const { FluxAppSpecV9 } = await load();
    const wire = FluxAppSpecV9.fromSubmission(v9submission).serialize();
    const lines = serverLines(await render(wire, ACTIVE, DRAINING));
    expect(lines).to.have.lengthOf(3);
    expect(lines[2]).to.contain('135.148.60.40:16127');
    expect(lines[2]).to.contain('disabled');
  });

  it('draining backends render after the in-rotation ones', async () => {
    const lines = serverLines(await render(v8spec(), ACTIVE, DRAINING));
    expect(lines[0]).to.contain('144.76.10.20');
    expect(lines[1]).to.contain('167.86.90.30');
    expect(lines[2]).to.contain('135.148.60.40');
  });

  it('no draining backends renders exactly as before', async () => {
    const withNone = await render(v8spec(), ACTIVE, []);
    const withoutArg = await render(v8spec(), ACTIVE, undefined);
    expect(withNone).to.equal(withoutArg);
    expect(withNone).to.not.contain('disabled');
  });

  it('a draining backend is never also marked backup under syncFirst', async () => {
    // syncFirst renders every non-first in-rotation backend as `backup`; a draining one
    // is in maintenance instead, and the two states must not both appear on a line.
    const lines = serverLines(await render(v8spec('r:/data'), ACTIVE, DRAINING, true));
    expect(lines[1]).to.contain('backup');
    expect(lines[2]).to.contain('disabled');
    expect(lines[2]).to.not.contain('backup');
  });

  it('an ip in both lists is rendered once — a duplicate server name is fatal to haproxy', async () => {
    const lines = serverLines(await render(v8spec(), ACTIVE, [ACTIVE[0]]));
    expect(lines).to.have.lengthOf(2);
    expect(lines.filter((l) => l.includes('disabled'))).to.have.lengthOf(0);
  });

  it('backend timeouts are still emitted when every remaining backend is draining', async () => {
    const text = await render(v8spec(), [], DRAINING);
    expect(text).to.contain('timeout server');
    expect(serverLines(text)).to.have.lengthOf(1);
    expect(serverLines(text)[0]).to.contain('disabled');
  });
});

// The per-app coded health probes need a port to probe. They used to read it straight off
// raw compose, in a version-shaped expression that could not work for v9 — and, on the
// generalWebsite branch, could not work for a v1-3 app either:
//
//   app.port || app.ports ? app.ports[0] : app.compose[0].ports[0]
//
// `||` binds tighter than `?:`, so that reads `(app.port || app.ports) ? ...`. A v1/v2
// spec carrying the singular `port` therefore takes the true arm and dereferences
// `app.ports[0]` — which is undefined — and a v9 spec takes the false arm and
// dereferences `app.compose`, which does not exist at all.
//
// routedPort replaces it with the resolved DeploymentSpec's routes, which every version
// normalizes onto.
const chai = require('chai');
const { load } = require('@runonflux/flux-spec-cjs');
const specLibs = require('../../src/services/flux/specLibs');
const { routedPort } = require('../../src/services/application/checks');

const { expect } = chai;

const composeComponent = (name, ports, containerPorts) => ({
  name,
  description: name,
  repotag: 'nginx:latest',
  ports,
  domains: ports.map(() => ''),
  environmentParameters: [],
  commands: [],
  containerPorts,
  containerData: '/data',
  cpu: 0.1,
  ram: 100,
  hdd: 1,
  repoauth: '',
});

const v8spec = (components) => ({
  version: 8,
  name: 'probeapp',
  description: 'x',
  owner: '19z6SjrVrWqBTLiCXWLRjcu9ydnzWNz3UD',
  compose: components,
  instances: 3,
  contacts: [],
  geolocation: [],
  expire: 88000,
  nodes: [],
  staticip: false,
});

const v9submission = {
  version: 9,
  name: 'probeapp',
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
      persistentStorage: { sizeGb: 5 },
      ports: {
        http: { containerPort: 80, hostPort: 31000 },
        admin: { containerPort: 81, hostPort: 31001 },
      },
      loadBalancing: {
        http: { provider: 'haproxy', mode: 'http' },
        admin: { provider: 'haproxy', mode: 'http' },
      },
    },
  },
};

const deploymentOf = async (spec) => specLibs.resolveDeployment(await specLibs.deserialize(spec), null);

describe('probe port resolution', () => {
  it('legacy: the first routed port is the first component port', async () => {
    const dep = await deploymentOf(v8spec([composeComponent('app', [31000, 31001], [80, 81])]));
    expect(routedPort(dep)).to.equal(31000);
  });

  it('legacy: index 1 is the second port of the same component (the Algorand probe)', async () => {
    const dep = await deploymentOf(v8spec([composeComponent('app', [31000, 31001], [80, 81])]));
    expect(routedPort(dep, 1)).to.equal(31001);
  });

  it('v9: resolves a port where the old raw-compose read threw', async () => {
    const { FluxAppSpecV9 } = await load();
    const wire = FluxAppSpecV9.fromSubmission(v9submission).serialize();
    const dep = await deploymentOf(wire);
    expect(routedPort(dep)).to.equal(31000);
    expect(routedPort(dep, 1)).to.equal(31001);
    // The expression it replaced, on the same spec.
    expect(() => (wire.port || wire.ports ? wire.ports[0] : wire.compose[0].ports[0])).to.throw();
  });

  it('skips a leading component that exposes no ports', async () => {
    // explorer/explorerb are shaped like this in production: compose[0] declares no ports,
    // so compose[0].ports[0] is undefined and the probe was handed an undefined port.
    const dep = await deploymentOf(v8spec([
      composeComponent('worker', [], []),
      composeComponent('api', [39185], [8080]),
    ]));
    expect(routedPort(dep)).to.equal(39185);
  });

  it('spans components in order once the first is exhausted', async () => {
    const dep = await deploymentOf(v8spec([
      composeComponent('api', [39185], [8080]),
      composeComponent('worker', [39186], [8081]),
    ]));
    expect(routedPort(dep, 0)).to.equal(39185);
    expect(routedPort(dep, 1)).to.equal(39186);
  });

  it('returns undefined rather than throwing when the port is not there', async () => {
    const dep = await deploymentOf(v8spec([composeComponent('app', [31000], [80])]));
    expect(routedPort(dep, 5)).to.equal(undefined);
    expect(routedPort(undefined)).to.equal(undefined);
    expect(routedPort(null, 2)).to.equal(undefined);
  });
});

// The shared-db operator listens on several ports, of which only the last is its API.
// A legacy spec routes every port it declares, so the internal ones arrive as routes and
// must be dropped before they become public backends.
//
// This only ever removes INFERRED routes — ones synthesized because the spec version
// routes every port. A v9 owner opts in per port, so their entries are deliberate and are
// left exactly as declared. That makes the policy a no-op on v9 by construction, which is
// what lets it be deleted once no app of this shape remains below v9.
const chai = require('chai');
const { load } = require('@runonflux/flux-spec-cjs');
const specLibs = require('../../src/services/flux/specLibs');
const { effectiveRoutes } = require('../../src/services/domain/effectiveRoutes');

const { expect } = chai;

const component = (name, repotag, ports, containerPorts) => ({
  name,
  description: name,
  repotag,
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

const legacySpec = (components) => ({
  version: 8,
  name: 'sharedbapp',
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

const v9spec = (operatorLoadBalancing) => ({
  version: 9,
  name: 'sharedbapp',
  description: 'x',
  owner: '16dNCFf7nR3nx5iwn2RQMBw6KcJXkE3JC1',
  ttl: 2592000,
  instances: 3,
  contacts: { email: ['a@b.com'] },
  components: {
    app: {
      name: 'app',
      description: 'x',
      image: 'nginx:latest',
      cpu: 0.5,
      memory: 300,
      rootFsGb: 2,
      ports: { http: { containerPort: 80, hostPort: 31000 } },
      loadBalancing: { http: { provider: 'haproxy', mode: 'http' } },
    },
    operator: {
      name: 'operator',
      description: 'x',
      image: 'runonflux/shared-db:latest',
      cpu: 0.5,
      memory: 300,
      rootFsGb: 2,
      ports: {
        internal: { containerPort: 7071, hostPort: 31002 },
        api: { containerPort: 8008, hostPort: 31003 },
      },
      loadBalancing: operatorLoadBalancing,
    },
  },
});

const routesOf = async (spec) => {
  const deployment = await specLibs.resolveDeployment(await specLibs.deserialize(spec), null);
  return effectiveRoutes(deployment).map((r) => [r.componentName, r.hostPort]);
};

const v9routesOf = async (submission) => {
  const { FluxAppSpecV9 } = await load();
  return routesOf(FluxAppSpecV9.fromSubmission(submission).serialize());
};

describe('shared-db internal ports are not published', () => {
  it('legacy: keeps only the operator API port, leaving other components alone', async () => {
    const routes = await routesOf(legacySpec([
      component('web', 'nginx:latest', [37689], [2368]),
      component('mysql', 'mysql:8.3.0', [], []),
      component('operator', 'runonflux/shared-db:latest', [36477, 38451, 32069], [3307, 7071, 8008]),
    ]));
    expect(routes).to.deep.equal([['web', 37689], ['operator', 32069]]);
  });

  it('legacy: an operator with a single port is untouched', async () => {
    const routes = await routesOf(legacySpec([
      component('web', 'nginx:latest', [37689], [2368]),
      component('operator', 'runonflux/shared-db:latest', [32069], [8008]),
    ]));
    expect(routes).to.deep.equal([['web', 37689], ['operator', 32069]]);
  });

  it('leaves an app with no shared-db component completely alone', async () => {
    const routes = await routesOf(legacySpec([
      component('web', 'nginx:latest', [37689, 37690], [2368, 2369]),
    ]));
    expect(routes).to.deep.equal([['web', 37689], ['web', 37690]]);
  });

  // The policy must never overrule a v9 owner. If they publish two operator ports on
  // purpose, both stay — they were asked for, not inferred.
  it('v9: keeps every port the owner explicitly declared, even two on the operator', async () => {
    const routes = await v9routesOf(v9spec({
      internal: { provider: 'haproxy', mode: 'http' },
      api: { provider: 'haproxy', mode: 'http' },
    }));
    expect(routes).to.deep.equal([['app', 31000], ['operator', 31002], ['operator', 31003]]);
  });

  it('v9: an owner publishing only the API port needs no policy at all', async () => {
    const routes = await v9routesOf(v9spec({ api: { provider: 'haproxy', mode: 'http' } }));
    expect(routes).to.deep.equal([['app', 31000], ['operator', 31003]]);
  });
});

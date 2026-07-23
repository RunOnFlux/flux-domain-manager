/* eslint-disable func-names */
// Proves FDM consumes flux-spec through the CommonJS bridge: version-dispatched
// deserialize, then DeploymentSpec resolution with ports x loadBalancing merged and
// per-replica effective ports applied. Uses a synthetic valid v9 spec; the exhaustive
// cross-version deserialize of real specs lives in the local sweep.
const chai = require('chai');
const { load } = require('@runonflux/flux-spec-cjs');
const { deserialize, resolveDeployment } = require('../../src/services/flux/specLibs');

const { expect } = chai;

const V9_BLOB = {
  version: 9,
  name: 'speclibs-smoke',
  description: 'specLibs smoke',
  owner: '16dNCFf7nR3nx5iwn2RQMBw6KcJXkE3JC1',
  ttl: 2592000,
  contacts: { email: ['admin@example.com'] },
  // two replicas co-located on one node; r2's http port overridden. The name->node
  // map is `assignment`; the cleartext `placement` identity set, its mode, and
  // `instances` are derived projections of it.
  assignment: { targetIps: { '10.0.0.1': ['r1', 'r2'] } },
  components: {
    web: {
      name: 'web',
      description: 'web',
      image: 'nginx:latest',
      cpu: 0.5,
      memory: 300,
      rootFsGb: 2,
      persistentStorage: { sizeGb: 10, mounts: { '/data': { source: 'data', destination: '/data' } } },
      ports: { http: { containerPort: 80, hostPort: 31000 } },
      loadBalancing: { http: { provider: 'haproxy', mode: 'http' } },
      replicaOverrides: { r2: { ports: { http: { hostPort: 31001 } } } },
    },
  },
};

describe('flux-spec consumption (specLibs)', function () {
  let wire;

  before(async function () {
    const { FluxAppSpecV9 } = await load();
    wire = FluxAppSpecV9.fromSubmission(V9_BLOB).serialize();
  });

  it('deserialize() dispatches to the version class', async function () {
    const spec = await deserialize(wire);
    expect(spec.constructor.name).to.equal('FluxAppSpecV9');
    expect(spec.version).to.equal(9);
  });

  it('resolveDeployment() merges the host port into each LB entry', async function () {
    const spec = await deserialize(wire);
    const lb = (await resolveDeployment(spec, null)).getComponent('web').loadBalancing;
    expect(lb).to.have.property('http');
    expect(lb.http).to.include({ provider: 'haproxy', mode: 'http', hostPort: 31000 });
  });

  it('resolveDeployment(replica) applies the per-replica effective host port', async function () {
    const spec = await deserialize(wire);
    const r1 = (await resolveDeployment(spec, 'r1')).getComponent('web').loadBalancing.http.hostPort;
    const r2 = (await resolveDeployment(spec, 'r2')).getComponent('web').loadBalancing.http.hostPort;
    expect(r1).to.equal(31000);
    expect(r2).to.equal(31001);
  });
});

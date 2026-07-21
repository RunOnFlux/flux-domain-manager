/* eslint-disable func-names */
// The adapter turns a v9 spec + its location rows into HTTP backends: one per
// haproxy/http port (skipping powerdns/dns and non-LB ports), with one
// distinct-named server per replica at that replica's effective host port.
const chai = require('chai');
const { load } = require('@runonflux/flux-spec-cjs');
const { buildHttpBackends } = require('../../src/services/haproxy/buildHttpBackends');

const { expect } = chai;

const base = () => ({
  version: 9, name: 'shop', description: 'x',
  owner: '16dNCFf7nR3nx5iwn2RQMBw6KcJXkE3JC1', ttl: 2592000,
  contacts: { email: ['a@b.com'] },
});
const comp = (extra) => ({
  name: 'web', description: 'x', image: 'nginx:latest', cpu: 0.5, memory: 300, rootFsGb: 2,
  persistentStorage: { sizeGb: 10, mounts: { '/data': { source: 'data', destination: '/data' } } },
  ...extra,
});

describe('buildHttpBackends', function () {
  let FluxAppSpecV9;
  before(async function () { ({ FluxAppSpecV9 } = await load()); });

  it('emits one distinct-named server per co-located replica at its effective port', async function () {
    const spec = FluxAppSpecV9.fromSubmission({
      ...base(),
      placement: { targetIps: { '10.0.0.1': ['r1', 'r2'] } },
      components: { web: comp({
        ports: { http: { containerPort: 80, hostPort: 31000 } },
        loadBalancing: { http: { provider: 'haproxy', mode: 'http' } },
        replicaOverrides: { r2: { ports: { http: { hostPort: 31001 } } } },
      }) },
    });
    const backends = await buildHttpBackends(spec, [
      { ip: '10.0.0.1', replica: 'r1' },
      { ip: '10.0.0.1', replica: 'r2' },
    ]);
    expect(backends).to.have.lengthOf(1);
    expect(backends[0].lb).to.include({ provider: 'haproxy', mode: 'http' });
    expect(backends[0].servers.map((s) => s.port).sort()).to.deep.equal([31000, 31001]);
    expect(new Set(backends[0].servers.map((s) => s.name)).size).to.equal(2);
    expect(backends[0].domains.length).to.be.greaterThan(0);
  });

  it('skips ports without a load balancer and non-haproxy/http providers', async function () {
    const spec = FluxAppSpecV9.fromSubmission({
      ...base(),
      instances: 1,
      components: { web: comp({
        ports: {
          http: { containerPort: 80, hostPort: 31000 },
          game: { containerPort: 53, hostPort: 32000 },
          metrics: { containerPort: 9090, hostPort: 33000 },
        },
        // http -> built; game -> powerdns (DNS manager's job) -> skipped; metrics -> no LB -> skipped
        loadBalancing: {
          http: { provider: 'haproxy', mode: 'http' },
          game: { provider: 'powerdns', healthCheckPort: 32000 },
        },
      }) },
    });
    const backends = await buildHttpBackends(spec, [{ ip: '10.0.0.1', replica: null }]);
    expect(backends).to.have.lengthOf(1);
    expect(backends[0].lb.provider).to.equal('haproxy');
  });
});

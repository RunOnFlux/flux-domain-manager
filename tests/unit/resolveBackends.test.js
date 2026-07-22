// resolveBackends is the one place config assembly consults runtime backend state: the
// drain filter (a draining/stopping replica is pulled from rotation) and syncFirst, which
// makes a shared-db app serve from one instance and leaves every other app serving from
// all of them. v8 specs keep this stable and independent of the v9 submission schema.
const chai = require('chai');
const { resolveBackends } = require('../../src/services/domainService');

const { expect } = chai;

// A minimal, deserializable v8 spec with a configurable primary-mount sync prefix. The
// name is not in the app-checks list, so it takes the plain backend path (locations ->
// ips) rather than the coded-checks path.
const v8spec = (containerData, extraComponents = []) => ({
  version: 8,
  name: 'zzsyncbackendtest',
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
  }, ...extraComponents],
  instances: 3,
  contacts: [],
  geolocation: [],
  expire: 88000,
  nodes: [],
  staticip: false,
});

const loc = (ip, state) => ({ ip, name: 'zzsyncbackendtest', state });

describe('resolveBackends — drain + version-blind syncFirst', () => {
  it('drain: draining/stopping backends are pulled from rotation (absent state kept)', async () => {
    const appIps = await resolveBackends(v8spec('/data'), [
      loc('1.1.1.1:16127', 'active'),
      loc('2.2.2.2:16127', 'draining'),
      loc('3.3.3.3:16127', 'stopping'),
      loc('4.4.4.4:16127', undefined),
    ]);
    expect(appIps).to.deep.equal(['1.1.1.1:16127', '4.4.4.4:16127']);
  });

  it('syncFirst: false for an r: app, whose replicated instances all serve', async () => {
    const app = v8spec('r:/data');
    await resolveBackends(app, [loc('1.1.1.1:16127', 'active')]);
    expect(app.syncFirst).to.equal(false);
  });

  it('syncFirst: true for a shared-db app, whose database takes writes on one instance', async () => {
    // No operator port, so no operator is asked for the cluster order.
    const app = v8spec('r:/data', [{
      name: 'operator',
      description: 'operator',
      repotag: 'runonflux/shared-db:latest',
      ports: [],
      domains: [],
      environmentParameters: [],
      commands: [],
      containerPorts: [],
      containerData: 's:/app/dumps',
      cpu: 0.1,
      ram: 100,
      hdd: 1,
      repoauth: '',
    }]);
    await resolveBackends(app, [loc('1.1.1.1:16127', 'active')]);
    expect(app.syncFirst).to.equal(true);
  });

  it('syncFirst: false for a plain app', async () => {
    const app = v8spec('/data');
    await resolveBackends(app, [loc('1.1.1.1:16127', 'active')]);
    expect(app.syncFirst).to.equal(false);
  });
});

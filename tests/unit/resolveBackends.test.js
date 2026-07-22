// resolveBackends is the one place config assembly consults runtime backend state. Its
// two new behaviours over the extracted-verbatim ordering are the drain filter (a
// draining/stopping replica is pulled from rotation) and version-blind syncFirst (from
// the typed sync mode, replacing the raw-compose r: scan). v8 specs keep this stable and
// independent of the v9 submission schema.
const chai = require('chai');
const { resolveBackends } = require('../../src/services/domainService');

const { expect } = chai;

// A minimal, deserializable v8 spec with a configurable primary-mount sync prefix
// (r: -> syncFirst, none -> plain). The name is not in the app-checks list, so it takes
// the plain backend path (locations -> ips) rather than the coded-checks path.
const v8spec = (containerData) => ({
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
  }],
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

  it('syncFirst: true for a legacy r: app, sourced from the typed sync mode', async () => {
    const app = v8spec('r:/data');
    await resolveBackends(app, [loc('1.1.1.1:16127', 'active')]);
    expect(app.syncFirst).to.equal(true);
  });

  it('syncFirst: false for a plain app', async () => {
    const app = v8spec('/data');
    await resolveBackends(app, [loc('1.1.1.1:16127', 'active')]);
    expect(app.syncFirst).to.equal(false);
  });
});

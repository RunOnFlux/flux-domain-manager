'use strict';

// resolveBackends is the one place config assembly consults runtime backend state. Its
// behaviour over the extracted-verbatim ordering is the drain filter: a
// draining/stopping replica is pulled from rotation. v8 specs keep this stable and
// independent of the v9 submission schema.
//
// It used to derive syncFirst too and write it onto the app for the renderer to read
// back. It no longer computes it at all — the renderer resolves the same deployment and
// asks it — so what is left to check here is that this function does not touch the app
// it is handed. See syncFirstRendering.test.js for the flag itself.
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
    const { appIps } = await resolveBackends(v8spec('/data'), [
      loc('1.1.1.1:16127', 'active'),
      loc('2.2.2.2:16127', 'draining'),
      loc('3.3.3.3:16127', 'stopping'),
      loc('4.4.4.4:16127', undefined),
    ]);
    expect(appIps).to.deep.equal(['1.1.1.1:16127', '4.4.4.4:16127']);
  });

  it('drain: the draining backends are returned separately, not discarded', async () => {
    const { drainingIps } = await resolveBackends(v8spec('/data'), [
      loc('1.1.1.1:16127', 'active'),
      loc('2.2.2.2:16127', 'draining'),
      loc('3.3.3.3:16127', 'stopping'),
      loc('4.4.4.4:16127', undefined),
    ]);
    expect(drainingIps).to.deep.equal(['2.2.2.2:16127', '3.3.3.3:16127']);
  });

  it('drain: nothing draining yields an empty list, never undefined', async () => {
    const { appIps, drainingIps } = await resolveBackends(v8spec('/data'), [
      loc('1.1.1.1:16127', 'active'),
    ]);
    expect(appIps).to.deep.equal(['1.1.1.1:16127']);
    expect(drainingIps).to.deep.equal([]);
  });

  it('does not write to the app it is given', async () => {
    // The app map holds whichever form the app arrived in, and for an enterprise app
    // that is the decrypted spec the fetcher caches for 24-48h — a frozen flux-spec
    // domain object shared by every reader of that cache entry for as long as it
    // lives. Nothing here may leave a mark on it.
    //
    // Deliberately NOT frozen for this check. domainService is not in strict mode, so
    // a write to a frozen object is discarded in silence — freezing the fixture would
    // make this pass whether or not the write happened, which is the same blindness
    // that made the original side effect dangerous. An ordinary object records it.
    const app = v8spec('r:/data');
    const before = new Set(Object.keys(app));

    await resolveBackends(app, [loc('1.1.1.1:16127', 'active')]);

    const added = Object.keys(app).filter((k) => !before.has(k));
    expect(added, `resolveBackends added ${added.join(', ')} to the app`).to.deep.equal([]);
  });

  it('survives an app that refuses writes, which is what an enterprise app is', async () => {
    const app = Object.freeze(v8spec('r:/data'));

    const { appIps } = await resolveBackends(app, [loc('1.1.1.1:16127', 'active')]);

    expect(appIps).to.deep.equal(['1.1.1.1:16127']);
  });
});

'use strict';

// The per-app mechanics of a routing cycle. These lived inline in the two loops, which is
// why neither had a test: the loops read module-level state and every step inside reaches
// the network, so there was nothing a test could stand up.
const { expect } = require('chai');
const config = require('config');
const { resolveAppLocations, runPerApp } = require('../../src/services/haproxy/appCycle');
const { ConditionLog } = require('../../src/services/conditionLog');
const log = require('../../src/lib/log');

const silent = { report: () => {} };

describe('resolveAppLocations', () => {
  const neverCalled = async () => {
    throw new Error('should not have searched');
  };
  const answering = (locations) => async () => ({ answered: true, locations });
  const silentApi = async () => ({ answered: false, locations: [] });

  it('takes the locations the feed already has, without searching', async () => {
    const known = new Map([['myapp', [{ ip: '1.2.3.4:16127' }]]]);
    const found = await resolveAppLocations({ appName: 'myapp', known, fetchLocations: neverCalled });
    expect(found).to.deep.equal({ locations: [{ ip: '1.2.3.4:16127' }], requests: 0 });
  });

  it('searches directly for an app the feed does not carry', async () => {
    const found = await resolveAppLocations({ appName: 'fresh', known: new Map(), fetchLocations: answering([{ ip: '5.6.7.8:16127' }]) });
    expect(found).to.deep.equal({ locations: [{ ip: '5.6.7.8:16127' }], requests: 1 });
  });

  it('takes an answer that nothing is running it as final', async () => {
    const found = await resolveAppLocations({ appName: 'gone', known: new Map(), fetchLocations: answering([]) });
    expect(found).to.deep.equal({ locations: [], requests: 1 });
  });

  it('retries an API that did not answer, a bounded number of times', async () => {
    const found = await resolveAppLocations({
      appName: 'unknown', known: new Map(), fetchLocations: silentApi, attempts: 5,
    });
    expect(found).to.deep.equal({ locations: [], requests: 5 });
  });

  it('leaves the feed it reads untouched', async () => {
    const [appName] = Object.keys(config.staticLocations);
    const fed = [{ ip: '1.2.3.4:16127' }];
    await resolveAppLocations({ appName, known: new Map([[appName, fed]]), fetchLocations: neverCalled });
    expect(fed).to.deep.equal([{ ip: '1.2.3.4:16127' }]);
  });

  // A few blockbook apps serve from fixed IPv6 addresses the feed does not carry. That
  // list is config, not something written into the routing loop.
  it('adds the configured fixed addresses for an app that has them', async () => {
    const [appName] = Object.keys(config.staticLocations);
    const known = new Map([[appName, [{ ip: '1.2.3.4:16127' }]]]);
    const { locations } = await resolveAppLocations({ appName, known, fetchLocations: neverCalled });
    expect(locations).to.have.lengthOf(1 + config.staticLocations[appName].length);
    expect(locations.map((l) => l.ip)).to.include(config.staticLocations[appName][0]);
  });

  it('adds them even when the app appears nowhere else', async () => {
    const [appName] = Object.keys(config.staticLocations);
    const { locations } = await resolveAppLocations({
      appName, known: new Map(), fetchLocations: answering([]),
    });
    expect(locations.map((l) => l.ip)).to.deep.equal(config.staticLocations[appName]);
  });

  it('adds nothing extra for an app with no fixed addresses', async () => {
    const known = new Map([['plainapp', [{ ip: '1.2.3.4:16127' }]]]);
    const { locations } = await resolveAppLocations({ appName: 'plainapp', known, fetchLocations: neverCalled });
    expect(locations).to.have.lengthOf(1);
  });

  it('every configured entry is a bracketed IPv6 address with a port', () => {
    Object.values(config.staticLocations).flat().forEach((ip) => {
      expect(ip).to.match(/^\[[0-9a-f:]+\]:\d+$/);
    });
  });

  // The port on a fixed address is the app's own, unlike a feed location's, which is the
  // node's API port. Recording that here is what stops the probe having to guess an
  // address's provenance from whether it contains brackets.
  it('marks a fixed address with the service port it declares', async () => {
    const [appName] = Object.keys(config.staticLocations);
    const { locations } = await resolveAppLocations({
      appName, known: new Map(), fetchLocations: answering([]),
    });
    expect(locations).to.have.lengthOf(config.staticLocations[appName].length);
    locations.forEach((location) => {
      expect(location.servicePort).to.equal(location.ip.split(']:')[1]);
    });
  });

  it('leaves a feed location without a service port', async () => {
    const known = new Map([['plainapp', [{ ip: '1.2.3.4:16127' }]]]);
    const { locations: [location] } = await resolveAppLocations({ appName: 'plainapp', known, fetchLocations: neverCalled });
    expect(location.servicePort).to.equal(undefined);
  });
});

describe('runPerApp — one app never takes the cycle down', () => {
  it('runs the work for every app', async () => {
    const seen = [];
    const excluded = await runPerApp(
      [{ name: 'a' }, { name: 'b' }, { name: 'c' }],
      'Active-Active',
      async (app) => { seen.push(app.name); },
      silent,
    );
    expect(seen).to.deep.equal(['a', 'b', 'c']);
    expect(excluded).to.deep.equal([]);
  });

  // The behaviour the PANIC throws used to break: a failure mid-cycle abandoned every
  // remaining app's routing update, not just its own.
  it('carries on after an app throws, and keeps the later apps', async () => {
    const seen = [];
    const excluded = await runPerApp(
      [{ name: 'a' }, { name: 'boom' }, { name: 'c' }],
      'Active-Active',
      async (app) => {
        if (app.name === 'boom') throw new Error('spec will not resolve');
        seen.push(app.name);
      },
      silent,
    );
    expect(seen).to.deep.equal(['a', 'c']);
    expect(excluded).to.deep.equal(['boom']);
  });

  it('excludes every app that fails, and only those', async () => {
    const excluded = await runPerApp(
      [{ name: 'a' }, { name: 'b' }, { name: 'c' }, { name: 'd' }],
      'Active-Standby',
      async (app) => { if (app.name === 'b' || app.name === 'd') throw new Error('nope'); },
      silent,
    );
    expect(excluded).to.deep.equal(['b', 'd']);
  });

  describe('its log', () => {
    let lines;
    let originals;
    beforeEach(() => {
      lines = [];
      originals = { info: log.info, warn: log.warn };
      log.info = (m) => lines.push(m);
      log.warn = (m) => lines.push(m);
    });
    afterEach(() => { log.info = originals.info; log.warn = originals.warn; });

    const boom = async () => { throw new Error('spec will not resolve'); };
    const fine = async () => {};

    it('names the app, the loop and the error when an app starts failing', async () => {
      await runPerApp([{ name: 'boom' }], 'Active-Standby', boom, new ConditionLog());
      expect(lines).to.have.lengthOf(1);
      expect(lines[0]).to.contain('Active-Standby');
      expect(lines[0]).to.contain('boom');
      expect(lines[0]).to.contain('spec will not resolve');
    });

    it('says nothing more while the app keeps failing', async () => {
      const failures = new ConditionLog();
      await runPerApp([{ name: 'boom' }], 'Active-Standby', boom, failures);
      await runPerApp([{ name: 'boom' }], 'Active-Standby', boom, failures);
      await runPerApp([{ name: 'boom' }], 'Active-Standby', boom, failures);
      expect(lines).to.have.lengthOf(1);
    });

    it('says once that the app routes again', async () => {
      const failures = new ConditionLog();
      await runPerApp([{ name: 'boom' }], 'Active-Standby', boom, failures);
      await runPerApp([{ name: 'boom' }], 'Active-Standby', fine, failures);
      await runPerApp([{ name: 'boom' }], 'Active-Standby', fine, failures);
      expect(lines).to.have.lengthOf(2);
      expect(lines[1]).to.contain('boom');
      expect(lines[1]).to.contain('cleared');
    });

    it('says nothing for an app that never failed', async () => {
      await runPerApp([{ name: 'ok' }], 'Active-Active', fine, new ConditionLog());
      expect(lines).to.deep.equal([]);
    });
  });

  it('survives an app that fails synchronously', async () => {
    const excluded = await runPerApp([{ name: 'sync' }, { name: 'ok' }], 'Active-Active', (app) => {
      if (app.name === 'sync') throw new Error('threw before awaiting');
      return Promise.resolve();
    }, silent);
    expect(excluded).to.deep.equal(['sync']);
  });
});

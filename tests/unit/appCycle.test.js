// The per-app mechanics of a routing cycle. These lived inline in the two loops, which is
// why neither had a test: the loops read module-level state and every step inside reaches
// the network, so there was nothing a test could stand up.
const { expect } = require('chai');
const config = require('config');
const { resolveAppLocations, runPerApp } = require('../../src/services/haproxy/appCycle');

const silent = { error: () => {} };

describe('resolveAppLocations', () => {
  const neverCalled = async () => {
    throw new Error('should not have searched');
  };

  it('takes the locations the feed already has, without searching', async () => {
    const known = new Map([['myapp', [{ ip: '1.2.3.4:16127' }]]]);
    const found = await resolveAppLocations({ appName: 'myapp', known, fetchLocations: neverCalled });
    expect(found).to.deep.equal([{ ip: '1.2.3.4:16127' }]);
  });

  it('searches directly for an app the feed does not carry', async () => {
    const known = new Map();
    let calls = 0;
    const fetchLocations = async () => { calls += 1; return [{ ip: '5.6.7.8:16127' }]; };
    const found = await resolveAppLocations({ appName: 'fresh', known, fetchLocations });
    expect(calls).to.equal(1);
    expect(found).to.deep.equal([{ ip: '5.6.7.8:16127' }]);
  });

  it('gives up after a bounded number of searches rather than spinning', async () => {
    const known = new Map();
    let calls = 0;
    const fetchLocations = async () => { calls += 1; return []; };
    const found = await resolveAppLocations({
      appName: 'gone', known, fetchLocations, attempts: 5,
    });
    expect(calls).to.equal(5);
    expect(found).to.deep.equal([]);
  });

  // A few blockbook apps serve from fixed IPv6 addresses the feed does not carry. That
  // list is config, not something written into the routing loop.
  it('adds the configured fixed addresses for an app that has them', async () => {
    const [appName] = Object.keys(config.staticLocations);
    const known = new Map([[appName, [{ ip: '1.2.3.4:16127' }]]]);
    const found = await resolveAppLocations({ appName, known, fetchLocations: neverCalled });
    expect(found).to.have.lengthOf(1 + config.staticLocations[appName].length);
    expect(found.map((l) => l.ip)).to.include(config.staticLocations[appName][0]);
  });

  it('adds them even when the app appears nowhere else', async () => {
    const [appName] = Object.keys(config.staticLocations);
    const found = await resolveAppLocations({
      appName, known: new Map(), fetchLocations: async () => [], attempts: 1,
    });
    expect(found.map((l) => l.ip)).to.deep.equal(config.staticLocations[appName]);
  });

  it('adds nothing extra for an app with no fixed addresses', async () => {
    const known = new Map([['plainapp', [{ ip: '1.2.3.4:16127' }]]]);
    const found = await resolveAppLocations({ appName: 'plainapp', known, fetchLocations: neverCalled });
    expect(found).to.have.lengthOf(1);
  });

  it('every configured entry is a bracketed IPv6 address with a port', () => {
    Object.values(config.staticLocations).flat().forEach((ip) => {
      expect(ip).to.match(/^\[[0-9a-f:]+\]:\d+$/);
    });
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

  it('names the app and the loop in the log, so an exclusion is traceable', async () => {
    const lines = [];
    await runPerApp([{ name: 'boom' }], 'Active-Standby', async () => {
      throw new Error('spec will not resolve');
    }, { error: (m) => lines.push(m) });
    expect(lines).to.have.lengthOf(1);
    expect(lines[0]).to.contain('Active-Standby');
    expect(lines[0]).to.contain('boom');
    expect(lines[0]).to.contain('spec will not resolve');
  });

  it('survives an app that fails synchronously', async () => {
    const excluded = await runPerApp([{ name: 'sync' }, { name: 'ok' }], 'Active-Active', (app) => {
      if (app.name === 'sync') throw new Error('threw before awaiting');
      return Promise.resolve();
    }, silent);
    expect(excluded).to.deep.equal(['sync']);
  });
});

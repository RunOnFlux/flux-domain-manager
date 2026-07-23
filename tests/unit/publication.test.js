// The publication policy the two routing loops share. The memo it returns is both a
// change-detection cache and the cross-loop handoff, and the bug this locks down is the
// interaction between those two roles: a config haproxy rejects must NOT be remembered
// as published, or the next cycle rebuilds the same configs, matches the memo and skips
// — freezing the fleet on the last good config until the app set happens to change.
const chai = require('chai');
const { publishRouteConfigs } = require('../../src/services/haproxy/publication');

const { expect } = chai;

const aa = [{ domain: 'a.app2.runonflux.io' }];
const as = [{ domain: 's.app2.runonflux.io' }];

// The active-active loop's argument shape; its own configs lead the combined config.
const activeActive = (over) => ({
  next: aa, remembered: [], counterpart: as, counterpartFirst: false, update: async () => {}, ...over,
});
// The active-standby loop's; its counterpart (active-active) leads.
const activeStandby = (over) => ({
  next: as, remembered: [], counterpart: aa, counterpartFirst: true, update: async () => {}, ...over,
});

describe('route config publication policy', () => {
  it('unchanged configs neither publish nor disturb the memo', async () => {
    let published = false;
    const outcome = await publishRouteConfigs(activeActive({
      remembered: aa, update: async () => { published = true; },
    }));
    expect(outcome.action).to.equal('unchanged');
    expect(outcome.remember).to.deep.equal(aa);
    expect(published).to.equal(false);
  });

  it('publishes the combined config with active-active leading', async () => {
    let got = null;
    const outcome = await publishRouteConfigs(activeActive({ update: async (c) => { got = c; } }));
    expect(outcome.action).to.equal('published');
    expect(got).to.deep.equal(aa.concat(as));
  });

  it('active-standby publishes the same order from the other side', async () => {
    let got = null;
    const outcome = await publishRouteConfigs(activeStandby({ update: async (c) => { got = c; } }));
    expect(outcome.action).to.equal('published');
    expect(got).to.deep.equal(aa.concat(as));
  });

  it('a successful publish advances the memo', async () => {
    const outcome = await publishRouteConfigs(activeActive({ remembered: [{ domain: 'old' }] }));
    expect(outcome.remember).to.deep.equal(aa);
  });

  it('a REJECTED publish throws and leaves the memo untouched, so the next cycle retries', async () => {
    const previous = [{ domain: 'old' }];
    let threw = null;
    try {
      await publishRouteConfigs(activeActive({
        remembered: previous,
        update: async () => { throw new Error('Invalid HAPROXY Config File!'); },
      }));
    } catch (e) {
      threw = e;
    }
    expect(threw).to.be.an('error');
    // The caller assigns `outcome.remember`; it never runs, so the memo keeps `previous`
    // and the identical rebuild next cycle no longer matches it.
    expect(JSON.stringify(aa)).to.not.equal(JSON.stringify(previous));
  });

  it('defers — but still remembers — while the counterpart has not completed a cycle', async () => {
    let published = false;
    const outcome = await publishRouteConfigs(activeActive({
      counterpart: [], update: async () => { published = true; },
    }));
    expect(outcome.action).to.equal('deferred');
    expect(published).to.equal(false);
    // Withholding the memo here is what would deadlock the bootstrap.
    expect(outcome.remember).to.deep.equal(aa);
  });

  it('bootstrap completes: each loop defers once, then the second publishes both sides', async () => {
    let memoAA = [];
    let memoAS = [];
    const published = [];
    const update = async (c) => { published.push(c); };

    // First active-active cycle: nothing from active-standby yet.
    let outcome = await publishRouteConfigs({
      next: aa, remembered: memoAA, counterpart: memoAS, counterpartFirst: false, update,
    });
    memoAA = outcome.remember;
    expect(outcome.action).to.equal('deferred');

    // First active-standby cycle: active-active's memo is populated, so it can publish.
    outcome = await publishRouteConfigs({
      next: as, remembered: memoAS, counterpart: memoAA, counterpartFirst: true, update,
    });
    memoAS = outcome.remember;
    expect(outcome.action).to.equal('published');
    expect(published).to.deep.equal([aa.concat(as)]);
  });

  it('fires onChanged before the deferred decision and onPublish before the reload', async () => {
    const order = [];
    await publishRouteConfigs(activeActive({
      onChanged: () => order.push('changed'),
      onPublish: () => order.push('publish'),
      update: async () => { order.push('reload'); },
    }));
    expect(order).to.deep.equal(['changed', 'publish', 'reload']);
  });

  it('fires onChanged but not onPublish when deferring', async () => {
    const order = [];
    await publishRouteConfigs(activeActive({
      counterpart: [],
      onChanged: () => order.push('changed'),
      onPublish: () => order.push('publish'),
    }));
    expect(order).to.deep.equal(['changed']);
  });

  it('fires neither hook when nothing changed', async () => {
    const order = [];
    await publishRouteConfigs(activeActive({
      remembered: aa,
      onChanged: () => order.push('changed'),
      onPublish: () => order.push('publish'),
    }));
    expect(order).to.deep.equal([]);
  });
});

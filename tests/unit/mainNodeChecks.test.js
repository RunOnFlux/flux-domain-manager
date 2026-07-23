// hasManyApps decides whether a Flux node's view of the app population is complete enough
// for that node to serve the main domain. A node that knows about almost nothing is out of
// step with the network and must not be balanced onto, however healthy it looks otherwise.
const chai = require('chai');
const config = require('config');
const serviceHelper = require('../../src/services/serviceHelper');
const { hasManyApps } = require('../../src/services/application/checks');

const { expect } = chai;

const FLOOR = config.appChecks.mainNode.minKnownApps;

// A node's app list: `count` apps, including every mandatory app unless told otherwise.
const appList = (count, { omit = null } = {}) => {
  const mandatory = config.mandatoryApps.filter((name) => name !== omit);
  const filler = Array.from(
    { length: Math.max(0, count - mandatory.length) },
    (unused, i) => ({ name: `filler${i}` }),
  );
  return mandatory.map((name) => ({ name })).concat(filler);
};

describe('hasManyApps — is this node in step with the network', () => {
  let original;

  beforeEach(() => { original = serviceHelper.httpGetRequest; });
  afterEach(() => { serviceHelper.httpGetRequest = original; });

  const responding = (apps) => { serviceHelper.httpGetRequest = async () => ({ data: { data: apps } }); };

  it('accepts a node reporting the full population with every mandatory app', async () => {
    responding(appList(761));
    expect(await hasManyApps('1.2.3.4', 16127)).to.equal(true);
  });

  it('rejects a node whose list is large but missing a mandatory app', async () => {
    responding(appList(761, { omit: 'web' }));
    expect(await hasManyApps('1.2.3.4', 16127)).to.equal(false);
  });

  // The case that used to pass: the count test gated the mandatory-app loop rather than
  // the result, so a node knowing almost nothing skipped every check and returned true.
  it('rejects a node that knows about almost nothing', async () => {
    responding(appList(3));
    expect(await hasManyApps('1.2.3.4', 16127)).to.equal(false);
  });

  it('rejects on the count even when the few apps it knows are the mandatory ones', async () => {
    responding(config.mandatoryApps.map((name) => ({ name })));
    expect(await hasManyApps('1.2.3.4', 16127)).to.equal(false);
  });

  it('accepts exactly at the floor and rejects one below it', async () => {
    responding(appList(FLOOR));
    expect(await hasManyApps('1.2.3.4', 16127)).to.equal(true);
    responding(appList(FLOOR - 1));
    expect(await hasManyApps('1.2.3.4', 16127)).to.equal(false);
  });

  it('rejects a node that does not answer', async () => {
    serviceHelper.httpGetRequest = async () => { throw new Error('ECONNREFUSED'); };
    expect(await hasManyApps('1.2.3.4', 16127)).to.equal(false);
  });
});

// Which named apps get a coded health check, and which probe answers for them, is data in
// config/appChecks.json. One lookup serves both "does this app have a check" and "run it",
// so the two cannot disagree — they used to be separate if/else chains listing the same
// conditions, kept in step by hand.
//
// The probe table is injectable, so these exercise the dispatch without standing up any of
// the network calls it selects.
const chai = require('chai');
const config = require('config');
const { applicationWithChecks, checkApplication } = require('../../src/services/application/checks');

const { expect } = chai;

// Records which probe was chosen and what it was handed, in place of calling it.
function recordingProbes(sink) {
  const names = ['generalWebsite', 'fluxExplorer', 'bitcoinNode', 'alphExplorer', 'ethers', 'blockBook'];
  return Object.fromEntries(names.map((name) => [name, async (rule, ctx) => {
    sink.push({ probe: name, rule, ctx });
    return true;
  }]));
}

const dispatch = async (name, deployment = null, location = { ip: '1.2.3.4:16127' }) => {
  const sink = [];
  await checkApplication({ name }, location, deployment, recordingProbes(sink));
  return sink;
};

// A deployment stub exposing only what the probes read off it.
const deploymentWithPorts = (...hostPorts) => ({
  routes: () => hostPorts.map((hostPort) => ({ hostPort })),
});

describe('app check dispatch', () => {
  it('selects one probe per configured app, from config', () => {
    const configured = config.appChecks.checks;
    expect(configured.length).to.be.above(0);
    configured.forEach((rule) => {
      expect(rule.probe).to.be.a('string');
      expect(Boolean(rule.apps) !== Boolean(rule.prefix)).to.equal(true, `${rule.probe}: exactly one of apps/prefix`);
    });
  });

  it('agrees with itself: anything it will probe, it reports as having a check', async () => {
    const names = ['web', 'paoverview', 'explorer', 'explorerb', 'bitcoinnode', 'blockbookbitcoin', 'alphexplorer', 'BitgertRPC'];
    // eslint-disable-next-line no-restricted-syntax
    for (const name of names) {
      expect(applicationWithChecks({ name })).to.equal(true, name);
      // eslint-disable-next-line no-await-in-loop
      expect(await dispatch(name)).to.have.lengthOf(1, name);
    }
  });

  it('reports no check, and runs none, for an unlisted app', async () => {
    expect(applicationWithChecks({ name: 'somerandomapp' })).to.equal(false);
    expect(await dispatch('somerandomapp')).to.have.lengthOf(0);
  });

  it('passes the explorer its fixed port from config, not the deployment', async () => {
    const [call] = await dispatch('explorer', deploymentWithPorts(12345));
    expect(call.probe).to.equal('fluxExplorer');
    expect(call.rule.port).to.equal(39185);
  });

  it('gives the general website probe the app routed port', async () => {
    const [call] = await dispatch('web', deploymentWithPorts(35389));
    expect(call.probe).to.equal('generalWebsite');
    expect(call.ctx.deployment.routes()[0].hostPort).to.equal(35389);
  });

  // A location's port means one of two things: the node's API port when it came from the
  // platform feed, or the app's own port when it came from the configured fixed addresses.
  // Only the second is a port to probe, and the difference is carried on the location
  // rather than recovered from the punctuation of the address.
  it('hands a fixed IPv6 address its own host and service port', async () => {
    const [call] = await dispatch('blockbookdogecoin', deploymentWithPorts(36293), {
      ip: '[2001:41d0:d00:b800::26]:9132', servicePort: '9132',
    });
    expect(call.probe).to.equal('blockBook');
    expect(call.ctx.host).to.equal('[2001:41d0:d00:b800::26]');
    expect(call.ctx.servicePort).to.equal('9132');
  });

  it('gives a feed location no service port, so the probe takes it from the deployment', async () => {
    const [call] = await dispatch('blockbookdogecoin', deploymentWithPorts(36293), { ip: '1.2.3.4:16127' });
    expect(call.ctx.host).to.equal('1.2.3.4');
    expect(call.ctx.servicePort).to.equal(null);
  });

  it('carries each ethers app its own port, command and provider', async () => {
    const [bitgert] = await dispatch('BitgertRPC');
    const [fuse] = await dispatch('FuseRPC');
    expect(bitgert.rule.port).to.equal('32300');
    expect(bitgert.rule.providerURL).to.equal(null);
    expect(fuse.rule.port).to.equal('38545');
    expect(fuse.rule.providerURL).to.equal('https://fuse-mainnet.chainstacklabs.com');
  });

  it('matches an ethers app by prefix, as the names carry suffixes', async () => {
    const [call] = await dispatch('WanchainRpcNodeYear');
    expect(call.probe).to.equal('ethers');
    expect(call.rule.prefix).to.equal('WanchainRpc');
  });

  it('no longer probes apps that left the network', async () => {
    // eslint-disable-next-line no-restricted-syntax
    for (const name of ['HavenNodeMainnet', 'AlgorandRPCMainnet', 'ergo', 'CeloRPC', 'subnetbittensor', 'KDLaunch']) {
      expect(applicationWithChecks({ name })).to.equal(false, name);
    }
  });
});

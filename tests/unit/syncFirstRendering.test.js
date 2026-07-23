// A sync-first app must not take traffic on an instance whose data has not finished
// syncing: only the first backend serves, the rest render as haproxy `backup` servers
// and take over only if it fails.
//
// The flag is version-blind — resolveBackends derives it from the typed sync mode
// (`persistentStorage.sync.mode`), which legacy `r:` container data and a v9
// `syncFirst` declaration both resolve to. These tests drive it the same way the
// routing loop does, from the deployment rather than a hand-passed boolean, so the
// v9 spec shape is covered end to end. v9 has no corpus, so this fixture is the net.
const chai = require('chai');
const { load } = require('@runonflux/flux-spec-cjs');
const specLibs = require('../../src/services/flux/specLibs');
const { buildRouteConfigs } = require('../../src/services/haproxy/buildRouteConfigs');
const { looseBackends, looseDeployments } = require('./fixtures/renderPipeline');
const { generateDomainBackend } = require('../../src/services/haproxyTemplate');

const { expect } = chai;

const IPS = ['144.76.10.20:16127', '167.86.90.30:16127', '135.148.60.40:16127'];

const v9submission = (syncMode) => ({
  version: 9,
  name: 'syncapp',
  description: 'x',
  owner: '16dNCFf7nR3nx5iwn2RQMBw6KcJXkE3JC1',
  ttl: 2592000,
  instances: 3,
  contacts: { email: ['a@b.com'] },
  components: {
    web: {
      name: 'web',
      description: 'x',
      image: 'nginx:latest',
      cpu: 0.5,
      memory: 300,
      rootFsGb: 2,
      persistentStorage: {
        sizeGb: 10,
        mounts: { '/data': { source: 'data', destination: '/data' } },
        ...(syncMode ? { sync: { mode: syncMode } } : {}),
      },
      ports: { http: { containerPort: 80, hostPort: 31000 } },
      loadBalancing: { http: { provider: 'haproxy', mode: 'http' } },
    },
  },
});

// Resolve the deployment, derive syncFirst exactly as resolveBackends does, then render.
async function render(submission) {
  const { FluxAppSpecV9 } = await load();
  const wire = FluxAppSpecV9.fromSubmission(submission).serialize();
  const deployment = await specLibs.resolveDeployment(await specLibs.deserialize(wire), null);
  const syncFirst = Object.values(deployment.components).some((c) => c.requiresSyncBeforeStart());
  const routeConfigs = buildRouteConfigs(
    looseDeployments(deployment), 'syncapp', looseBackends(IPS), false, syncFirst,
  );
  const platform = routeConfigs.find((c) => c.domain.startsWith('syncapp_'));
  return { syncFirst, text: generateDomainBackend(platform, 'http').render() };
}

const serverLines = (text) => text.split('\n').filter((l) => l.trim().startsWith('server '));

describe('v9 sync-first renders standby backends as backup', () => {
  it('derives syncFirst from the v9 typed sync mode', async () => {
    const { syncFirst } = await render(v9submission('syncFirst'));
    expect(syncFirst).to.equal(true);
  });

  it('renders every backend after the first as backup', async () => {
    const { text } = await render(v9submission('syncFirst'));
    const lines = serverLines(text);
    expect(lines).to.have.lengthOf(3);
    expect(lines[0]).to.contain('144.76.10.20:16127');
    expect(lines[0]).to.not.contain('backup');
    expect(lines[1]).to.contain('backup');
    expect(lines[2]).to.contain('backup');
  });

  it('leaves an app with no sync mode taking traffic on every backend', async () => {
    const { syncFirst, text } = await render(v9submission(null));
    expect(syncFirst).to.equal(false);
    expect(serverLines(text).filter((l) => l.includes('backup'))).to.have.lengthOf(0);
  });

  // activeStandby is a different mechanism entirely: one instance is selected and the
  // others get no server line at all, rather than rendering as backups.
  it('does not treat activeStandby as sync-first', async () => {
    const { syncFirst, text } = await render(v9submission('activeStandby'));
    expect(syncFirst).to.equal(false);
    expect(serverLines(text).filter((l) => l.includes('backup'))).to.have.lengthOf(0);
  });
});

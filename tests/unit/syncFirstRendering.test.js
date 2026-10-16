// A shared-db app serves from one instance: only the first backend takes traffic, the
// rest render as haproxy `backup` servers and take over only if it fails. Its members
// acknowledge a write before the others have applied it, so a read through another
// instance can miss it. Every other app serves from all of its instances, including one
// whose volume syncs before it starts.
//
// The rule is domainService.runsSharedDb, and the rendering goes through the routing
// loop's own appendRouteConfigs, for a v9 submission and a legacy spec alike.
const chai = require('chai');
const { load } = require('@runonflux/flux-spec-cjs');
const specLibs = require('../../src/services/flux/specLibs');
const { runsSharedDb, appendRouteConfigs } = require('../../src/services/domainService');
const { looseBackends } = require('./fixtures/renderPipeline');
const { generateDomainBackend } = require('../../src/services/haproxyTemplate');

const { expect } = chai;

const IPS = ['144.76.10.20:16127', '167.86.90.30:16127', '135.148.60.40:16127'];

const v9submission = ({ syncMode = null, sharedDb = false } = {}) => ({
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
    ...(sharedDb ? {
      operator: {
        name: 'operator',
        description: 'x',
        image: 'runonflux/shared-db:latest',
        cpu: 0.1,
        memory: 100,
        rootFsGb: 1,
      },
    } : {}),
  },
});

// A legacy spec whose one component's volume syncs before it starts (`r:`).
const v8replicated = () => ({
  version: 8,
  name: 'syncapp',
  description: 'x',
  owner: '19z6SjrVrWqBTLiCXWLRjcu9ydnzWNz3UD',
  compose: [{
    name: 'web',
    description: 'web',
    repotag: 'nginx:latest',
    ports: [31000],
    domains: [''],
    environmentParameters: [],
    commands: [],
    containerPorts: [80],
    containerData: 'r:/data',
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

async function wireOf(spec) {
  const { FluxAppSpecV9 } = await load();
  return spec.version === 9 ? FluxAppSpecV9.fromSubmission(spec).serialize() : spec;
}

async function deploymentOf(spec) {
  return specLibs.resolveDeployment(await specLibs.deserialize(await wireOf(spec)), null);
}

async function renderedServers(spec) {
  const routeConfigs = [];
  await appendRouteConfigs(routeConfigs, await wireOf(spec), looseBackends(IPS), false);
  const platform = routeConfigs.find((c) => c.domain.startsWith('syncapp_'));
  return generateDomainBackend(platform, 'http').render()
    .split('\n')
    .filter((l) => l.trim().startsWith('server '));
}

describe('which apps serve from one instance', () => {
  it('a shared-db app does', async () => {
    expect(runsSharedDb(await deploymentOf(v9submission({ sharedDb: true })))).to.equal(true);
  });

  it('a v9 app whose volume syncs before it starts does not', async () => {
    expect(runsSharedDb(await deploymentOf(v9submission({ syncMode: 'syncFirst' })))).to.equal(false);
  });

  it('a legacy r: app does not', async () => {
    expect(runsSharedDb(await deploymentOf(v8replicated()))).to.equal(false);
  });

  it('an app with no sync mode does not', async () => {
    expect(runsSharedDb(await deploymentOf(v9submission()))).to.equal(false);
  });

  // activeStandby is a different mechanism: one instance is selected and the others get
  // no server line at all, rather than rendering as backups.
  it('an activeStandby app does not', async () => {
    expect(runsSharedDb(await deploymentOf(v9submission({ syncMode: 'activeStandby' })))).to.equal(false);
  });
});

describe('how it renders', () => {
  it('renders every backend of a shared-db app after the first as backup', async () => {
    const lines = await renderedServers(v9submission({ sharedDb: true }));
    expect(lines).to.have.lengthOf(3);
    expect(lines[0]).to.contain('144.76.10.20:16127');
    expect(lines[0]).to.not.contain('backup');
    expect(lines[1]).to.contain('backup');
    expect(lines[2]).to.contain('backup');
  });

  it('leaves a synced v9 app taking traffic on every backend', async () => {
    const lines = await renderedServers(v9submission({ syncMode: 'syncFirst' }));
    expect(lines).to.have.lengthOf(3);
    expect(lines.filter((l) => l.includes('backup'))).to.have.lengthOf(0);
  });

  it('leaves a legacy r: app taking traffic on every backend', async () => {
    const lines = await renderedServers(v8replicated());
    expect(lines).to.have.lengthOf(3);
    expect(lines.filter((l) => l.includes('backup'))).to.have.lengthOf(0);
  });
});

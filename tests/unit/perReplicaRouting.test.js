// Co-located replicas: two named replicas of one app on ONE node. They share a node
// address but are separate containers on separate host ports, so they must render as two
// distinct haproxy servers. haproxy rejects a duplicate server name FATALLY — it refuses
// the whole config, which in FDM means every app's routing, not just this one's.
//
// A named replica's effective component is a general deep merge of its override entry, so
// nothing about its routes may be assumed to match its siblings'. Each replica is
// resolved to its own DeploymentSpec and its own routes are read; the per-replica host
// port falls out of that rather than being special-cased. Today's schema allowlists only
// ports.hostPort and env, but that is validation policy and can widen, so the conflict
// cases below drive synthetic deployments that disagree on more than the port.
const chai = require('chai');
const { load } = require('@runonflux/flux-spec-cjs');
const specLibs = require('../../src/services/flux/specLibs');
const { buildRouteConfigs } = require('../../src/services/haproxy/buildRouteConfigs');
const { generateDomainBackend } = require('../../src/services/haproxyTemplate');
const { resolveBackends } = require('../../src/services/domainService');

const { expect } = chai;

const NODE_A = '10.0.0.1:16127';
const NODE_B = '10.0.0.2:16127';

// r1+r2 co-located on node A, r3 alone on node B. r2 and r3 override the host port, so
// the three replicas resolve to three different ports.
const submission = {
  version: 9,
  name: 'coloapp',
  description: 'co-located replicas',
  owner: '16dNCFf7nR3nx5iwn2RQMBw6KcJXkE3JC1',
  ttl: 2592000,
  contacts: { email: ['a@b.com'] },
  assignment: { targetIps: { '10.0.0.1': ['r1', 'r2'], '10.0.0.2': ['r3'] } },
  components: {
    web: {
      name: 'web',
      description: 'web',
      image: 'nginx:latest',
      cpu: 0.5,
      memory: 300,
      rootFsGb: 2,
      persistentStorage: { sizeGb: 5 },
      ports: { http: { containerPort: 80, hostPort: 31000 } },
      loadBalancing: { http: { provider: 'haproxy', mode: 'http', customDomains: ['colo.example.com'] } },
      replicaOverrides: {
        r2: { ports: { http: { hostPort: 31001 } } },
        r3: { ports: { http: { hostPort: 31002 } } },
      },
    },
  },
};

// Same app with owner-configured sticky sessions, to prove affinity can address
// co-located replicas individually.
const stickySubmission = {
  ...submission,
  components: {
    web: {
      ...submission.components.web,
      loadBalancing: {
        http: {
          ...submission.components.web.loadBalancing.http,
          stickySessions: { cookieName: 'COLOSESS', maxIdle: '30m', maxLife: '8h' },
        },
      },
    },
  },
};

const backend = (ip, replica, draining = false) => ({ ip, replica, draining });

async function deploymentsFor(replicas, sub = submission) {
  const { FluxAppSpecV9 } = await load();
  const wire = FluxAppSpecV9.fromSubmission(sub).serialize();
  const instance = await specLibs.deserialize(wire);
  // The declared view is always resolved: it is the app's public identity (domains,
  // backend names, tuning), independent of which replicas happen to be running.
  const map = new Map([[null, await specLibs.resolveDeployment(instance, null)]]);
  // eslint-disable-next-line no-restricted-syntax
  for (const replica of replicas) {
    // eslint-disable-next-line no-await-in-loop
    map.set(replica, await specLibs.resolveDeployment(instance, replica));
  }
  return map;
}

async function render(backends, { syncFirst = false, onConflict } = {}) {
  const deployments = await deploymentsFor([...new Set(backends.map((b) => b.replica))]);
  const configs = buildRouteConfigs(deployments, 'coloapp', backends, false, syncFirst, () => true, onConflict);
  return { configs, platform: configs.find((c) => c.domain.startsWith('coloapp_')) };
}

const serverLines = (text) => text.split('\n').filter((l) => l.trim().startsWith('server '));
const namesOf = (lines) => lines.map((l) => l.trim().split(/\s+/)[1]);
const addrsOf = (lines) => lines.map((l) => l.trim().split(/\s+/)[2]);

describe('per-replica routing', () => {
  describe('co-located replicas', () => {
    it('two replicas on one node render two servers, not one', async () => {
      const { platform } = await render([backend(NODE_A, 'r1'), backend(NODE_A, 'r2')]);
      expect(serverLines(generateDomainBackend(platform, 'http').render())).to.have.lengthOf(2);
    });

    it('server names are distinct — a duplicate name is fatal to haproxy', async () => {
      const { platform } = await render([backend(NODE_A, 'r1'), backend(NODE_A, 'r2')]);
      const names = namesOf(serverLines(generateDomainBackend(platform, 'http').render()));
      expect(names).to.deep.equal(['10.0.0.1:16127_r1', '10.0.0.1:16127_r2']);
      expect(new Set(names).size).to.equal(names.length);
    });

    it('each replica is addressed on the host port ITS deployment resolved', async () => {
      const { platform } = await render([backend(NODE_A, 'r1'), backend(NODE_A, 'r2')]);
      expect(addrsOf(serverLines(generateDomainBackend(platform, 'http').render())))
        .to.deep.equal(['10.0.0.1:31000', '10.0.0.1:31001']);
    });

    it('two replicas with the SAME port on one node still get distinct names', async () => {
      // env-only overrides leave the port alone; without the replica qualifier both
      // servers would be named for the node and haproxy would refuse the config.
      const deployments = await deploymentsFor(['r1']);
      deployments.set('rX', deployments.get('r1'));
      const configs = buildRouteConfigs(deployments, 'coloapp', [backend(NODE_A, 'r1'), backend(NODE_A, 'rX')], false, false);
      const platform = configs.find((c) => c.domain.startsWith('coloapp_'));
      const names = namesOf(serverLines(generateDomainBackend(platform, 'http').render()));
      expect(names).to.deep.equal(['10.0.0.1:16127_r1', '10.0.0.1:16127_rX']);
    });

    it('mixes co-located and single-replica nodes', async () => {
      const { platform } = await render([
        backend(NODE_A, 'r1'), backend(NODE_A, 'r2'), backend(NODE_B, 'r3'),
      ]);
      const lines = serverLines(generateDomainBackend(platform, 'http').render());
      expect(namesOf(lines)).to.deep.equal([
        '10.0.0.1:16127_r1', '10.0.0.1:16127_r2', '10.0.0.2:16127_r3',
      ]);
      expect(addrsOf(lines)).to.deep.equal([
        '10.0.0.1:31000', '10.0.0.1:31001', '10.0.0.2:31002',
      ]);
    });

    it('the node list stays de-duplicated — it answers "where does this run"', async () => {
      const { platform } = await render([
        backend(NODE_A, 'r1'), backend(NODE_A, 'r2'), backend(NODE_B, 'r3'),
      ]);
      expect(platform.ips).to.deep.equal([NODE_A, NODE_B]);
    });
  });

  describe('interaction with the rest of the backend', () => {
    it('sticky affinity addresses co-located replicas individually', async () => {
      // One node, two rotation targets. A cookie keyed on the node address alone could
      // not distinguish them, so affinity would be meaningless for co-located replicas.
      const deployments = await deploymentsFor(['r1', 'r2'], stickySubmission);
      const configs = buildRouteConfigs(deployments, 'coloapp', [backend(NODE_A, 'r1'), backend(NODE_A, 'r2')], false, false);
      const platform = configs.find((c) => c.domain.startsWith('coloapp_'));
      const text = generateDomainBackend(platform, 'http').render();
      expect(text).to.contain('cookie COLOSESS insert');
      const cookies = serverLines(text).map((l) => l.trim().split('cookie ')[1].split(/\s+/)[0]);
      expect(cookies).to.deep.equal(['10.0.0.1:16127_r1', '10.0.0.1:16127_r2']);
    });

    it('draining one replica leaves its co-located sibling in rotation', async () => {
      const { platform } = await render([backend(NODE_A, 'r1'), backend(NODE_A, 'r2', true)]);
      const lines = serverLines(generateDomainBackend(platform, 'http').render());
      expect(lines).to.have.lengthOf(2);
      expect(lines[0]).to.not.contain('disabled');
      expect(lines[1]).to.contain('10.0.0.1:31001');
      expect(lines[1]).to.contain('disabled');
    });

    it('syncFirst marks every replica after the first as backup, across nodes', async () => {
      const { platform } = await render([
        backend(NODE_A, 'r1'), backend(NODE_A, 'r2'), backend(NODE_B, 'r3'),
      ], { syncFirst: true });
      const lines = serverLines(generateDomainBackend(platform, 'http').render());
      expect(lines[0]).to.not.contain('backup');
      expect(lines[1]).to.contain('backup');
      expect(lines[2]).to.contain('backup');
    });

    it('replicas merge into one backend per custom domain', async () => {
      const { configs } = await render([backend(NODE_A, 'r1'), backend(NODE_A, 'r2')]);
      const custom = configs.filter((c) => c.domain === 'colo.example.com');
      expect(custom).to.have.lengthOf(1);
      expect(custom[0].servers.map((s) => s.replica)).to.deep.equal(['r1', 'r2']);
    });

    it('www. and test. variants carry every replica too', async () => {
      const { configs } = await render([backend(NODE_A, 'r1'), backend(NODE_A, 'r2')]);
      ['www.colo.example.com', 'test.colo.example.com'].forEach((domain) => {
        const found = configs.filter((c) => c.domain === domain);
        expect(found, domain).to.have.lengthOf(1);
        expect(found[0].servers, domain).to.have.lengthOf(2);
      });
    });
  });

  describe('replicas that disagree (possible once the override allowlist widens)', () => {
    // Synthetic deployments: the schema cannot express these today, which is exactly why
    // they need pinning — the behaviour must be defined before policy allows them.
    const stubDeployment = (route) => ({ routes: () => [route] });
    const httpRoute = (over) => ({
      componentName: 'web', portKey: 'http', hostPort: 31000, customDomains: [], ...over,
    });

    it('reports a replica that disagrees with the declared backend, and keeps the declared view', async () => {
      const seen = [];
      const deployments = new Map([
        [null, stubDeployment(httpRoute({ balancing: 'roundrobin', maxConnectionsPerServer: 100 }))],
        ['r1', stubDeployment(httpRoute({ balancing: 'roundrobin', maxConnectionsPerServer: 100 }))],
        ['r2', stubDeployment(httpRoute({ balancing: 'leastconn', maxConnectionsPerServer: 900 }))],
      ]);
      const configs = buildRouteConfigs(
        deployments,
        'coloapp',
        [backend(NODE_A, 'r1'), backend(NODE_A, 'r2')],
        false,
        false,
        () => true,
        (route, fields, replica) => seen.push({ route, fields, replica }),
      );
      expect(seen).to.have.lengthOf(1);
      expect(seen[0].fields).to.include.members(['balancing', 'maxConnectionsPerServer']);
      expect(seen[0].replica).to.equal('r2');
      expect(seen[0].route).to.equal('web/http');
      const platform = configs.find((c) => c.domain.startsWith('coloapp_'));
      expect(platform.balancing).to.equal('roundrobin');
    });

    it('still routes both replicas despite the disagreement', async () => {
      const deployments = new Map([
        [null, stubDeployment(httpRoute({ balancing: 'roundrobin' }))],
        ['r1', stubDeployment(httpRoute({ balancing: 'roundrobin' }))],
        ['r2', stubDeployment(httpRoute({ balancing: 'leastconn' }))],
      ]);
      const configs = buildRouteConfigs(deployments, 'coloapp', [backend(NODE_A, 'r1'), backend(NODE_A, 'r2')], false, false);
      const platform = configs.find((c) => c.domain.startsWith('coloapp_'));
      expect(platform.servers).to.have.lengthOf(2);
    });

    it('a differing host port is NOT a conflict — that is the per-replica binding', async () => {
      const seen = [];
      const deployments = new Map([
        [null, stubDeployment(httpRoute({ hostPort: 31000 }))],
        ['r1', stubDeployment(httpRoute({ hostPort: 31000 }))],
        ['r2', stubDeployment(httpRoute({ hostPort: 31001 }))],
      ]);
      const configs = buildRouteConfigs(
        deployments,
        'coloapp',
        [backend(NODE_A, 'r1'), backend(NODE_A, 'r2')],
        false,
        false,
        () => true,
        (...args) => seen.push(args),
      );
      expect(seen).to.have.lengthOf(0);
      const platform = configs.find((c) => c.domain.startsWith('coloapp_'));
      expect(platform.servers.map((s) => s.hostPort)).to.deep.equal([31000, 31001]);
    });

    it('a replica that does not expose the port contributes no server to it', async () => {
      const deployments = new Map([
        [null, stubDeployment(httpRoute({}))],
        ['r1', stubDeployment(httpRoute({}))],
        ['r2', { routes: () => [] }],
      ]);
      const configs = buildRouteConfigs(deployments, 'coloapp', [backend(NODE_A, 'r1'), backend(NODE_A, 'r2')], false, false);
      const platform = configs.find((c) => c.domain.startsWith('coloapp_'));
      expect(platform.servers.map((s) => s.replica)).to.deep.equal(['r1']);
    });

    it('a replica with no resolved deployment is skipped, never routed on a sibling\'s ports', async () => {
      const deployments = await deploymentsFor(['r1']);
      const configs = buildRouteConfigs(deployments, 'coloapp', [backend(NODE_A, 'r1'), backend(NODE_A, 'ghost')], false, false);
      const platform = configs.find((c) => c.domain.startsWith('coloapp_'));
      expect(platform.servers.map((s) => s.replica)).to.deep.equal(['r1']);
    });
  });

  describe('loose instances are untouched', () => {
    it('an unnamed replica keeps the historical node-address server name', async () => {
      const deployments = await deploymentsFor([null]);
      const configs = buildRouteConfigs(deployments, 'coloapp', [backend(NODE_A, null), backend(NODE_B, null)], false, false);
      const platform = configs.find((c) => c.domain.startsWith('coloapp_'));
      const names = namesOf(serverLines(generateDomainBackend(platform, 'http').render()));
      expect(names).to.deep.equal(['10.0.0.1:16127', '10.0.0.2:16127']);
    });
  });

  describe('resolveBackends carries the replica off the location rows', () => {
    const v8spec = {
      version: 8,
      name: 'zzcolotest',
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
        containerData: '/data',
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
    };
    const loc = (ip, replica, state) => ({
      ip, name: 'zzcolotest', replica, state,
    });

    it('one backend per running instance, so a co-located node appears twice', async () => {
      const { backends } = await resolveBackends({ ...v8spec }, [
        loc(NODE_A, 'r1', 'active'),
        loc(NODE_A, 'r2', 'active'),
        loc(NODE_B, 'r3', 'active'),
      ]);
      expect(backends).to.deep.equal([
        { ip: NODE_A, replica: 'r1', draining: false },
        { ip: NODE_A, replica: 'r2', draining: false },
        { ip: NODE_B, replica: 'r3', draining: false },
      ]);
    });

    it('a location with no replica name yields a loose backend', async () => {
      const { backends } = await resolveBackends({ ...v8spec }, [loc(NODE_A, undefined, 'active')]);
      expect(backends).to.deep.equal([{ ip: NODE_A, replica: null, draining: false }]);
    });

    it('drains one co-located replica without touching its sibling', async () => {
      const { backends, appIps } = await resolveBackends({ ...v8spec }, [
        loc(NODE_A, 'r1', 'active'),
        loc(NODE_A, 'r2', 'draining'),
      ]);
      expect(backends).to.deep.equal([
        { ip: NODE_A, replica: 'r1', draining: false },
        { ip: NODE_A, replica: 'r2', draining: true },
      ]);
      // The node is still in rotation — one of its replicas is still serving.
      expect(appIps).to.deep.equal([NODE_A]);
    });
  });
});

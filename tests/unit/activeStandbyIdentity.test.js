'use strict';

// An activeStandby app whose identity is known is found on a node by that identity,
// through GET /v2/apps/activestandby, because a v9 container is named by a component
// key only its node holds. A node without the route is asked by container name.
const http = require('http');
const { expect } = require('chai');
const domainService = require('../../src/services/domainService');
const applicationChecks = require('../../src/services/application/checks');

const { selectActiveStandbyPrimaries, resetActiveStandbyStickyState, setAppIdentities } = domainService;
const { ProbeState } = applicationChecks;

const IDENTITY = `b${'c'.repeat(52)}`;
const v9app = { version: 9, name: 'vapp' };
const v8app = {
  version: 8,
  name: 'zizy',
  compose: [{ name: 'app', containerData: 'g:/appdata' }],
};

// A stand-in node. `components` answers the identity route; `routeStatus` 404 is a
// FluxOS without it. `running` and `held` answer the name routes.
function serveNode({
  components = [], unreadable = [], routeStatus = 200, running = [], held = [],
} = {}) {
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url.startsWith('/v2/apps/activestandby')) {
      if (routeStatus !== 200) {
        res.writeHead(routeStatus);
        res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'no route' } }));
        return;
      }
      res.end(JSON.stringify({ data: { components, unreadable }, meta: {} }));
      return;
    }
    if (req.url.startsWith('/apps/heldcomponents')) {
      res.end(JSON.stringify({ status: 'success', data: held }));
      return;
    }
    res.end(JSON.stringify({ status: 'success', data: running }));
  });
  return new Promise((resolve) => { server.listen(0, '127.0.0.1', () => resolve(server)); });
}

describe('activeStandby apps found by identity', () => {
  const servers = [];
  const node = async (opts) => {
    const server = await serveNode(opts);
    servers.push(server);
    return `127.0.0.1:${server.address().port}`;
  };
  const select = async (app, ips) => {
    const chosen = await selectActiveStandbyPrimaries([app], new Map([[app.name, ips]]), { retries: 1 });
    return chosen.get(app.name);
  };

  beforeEach(() => setAppIdentities(new Map([[v9app.name, IDENTITY], [v8app.name, IDENTITY]])));
  afterEach(() => {
    while (servers.length) servers.pop().close();
    resetActiveStandbyStickyState(v9app.name);
    resetActiveStandbyStickyState(v8app.name);
    setAppIdentities(new Map());
  });

  it('routes a v9 app to the node running its activeStandby component', async () => {
    const standby = await node({ components: [] });
    const primary = await node({ components: [{ identity: IDENTITY, replica: null, state: 'running' }] });
    expect(await select(v9app, [standby, primary])).to.equal(primary);
  });

  it('routes it to a node holding the component when none runs it', async () => {
    const idle = await node({ components: [] });
    const holder = await node({ components: [{ identity: IDENTITY, replica: null, state: 'held' }] });
    expect(await select(v9app, [idle, holder])).to.equal(holder);
  });

  it('ignores another app on the same node', async () => {
    const other = await node({ components: [{ identity: `b${'d'.repeat(52)}`, replica: null, state: 'running' }] });
    expect(await select(v9app, [other])).to.equal(null);
  });

  it('matches a named replica by identity and replica', async () => {
    const colo = await node({ components: [{ identity: IDENTITY, replica: 'r2', state: 'running' }] });
    expect(await select(v9app, [`${colo}#r1`, `${colo}#r2`])).to.equal(`${colo}#r2`);
  });

  it('asks a node without the identity route by container name', async () => {
    const older = await node({ routeStatus: 404, running: [{ Names: ['/fluxapp_zizy'] }] });
    expect(await select(v8app, [older])).to.equal(older);
  });

  it('asks by container name for an app whose identity is not known', async () => {
    setAppIdentities(new Map());
    const legacy = await node({ components: [], running: [{ Names: ['/fluxapp_zizy'] }] });
    expect(await select(v8app, [legacy])).to.equal(legacy);
  });
});

describe('a node answer read as a verdict', () => {
  const answer = (overrides) => ({
    kind: 'running',
    identity: {
      ok: true, running: new Set(), held: new Set(), unreadable: new Set(), ...overrides,
    },
    names: null,
  });

  it('is unknown for an app the node cannot read, never not running', () => {
    expect(applicationChecks.stateOf(answer({ unreadable: new Set([IDENTITY]) }), v9app, IDENTITY))
      .to.equal(ProbeState.UNKNOWN);
  });

  it('is unknown when the identity route could not be read', () => {
    expect(applicationChecks.stateOf(answer({ ok: false }), v9app, IDENTITY)).to.equal(ProbeState.UNKNOWN);
  });

  it('is not running when the node answered without it', () => {
    expect(applicationChecks.stateOf(answer({}), v9app, IDENTITY)).to.equal(ProbeState.NOT_RUNNING);
  });
});

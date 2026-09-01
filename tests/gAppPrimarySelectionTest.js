/* eslint-disable func-names */
const chai = require('chai');
const http = require('http');

const { expect } = chai;
const domainService = require('../src/services/domainService');

const {
  selectGPrimaries, getGStickyIp, setGStickyState, resetGStickyState,
} = domainService;

// zizy: the app component holds the g: volume, mysql has its own local storage.
const zizySpec = {
  version: 8,
  name: 'zizy',
  compose: [
    { name: 'app', containerData: 'g:/appdata' },
    { name: 'mysql', containerData: '/var/lib/mysql' },
  ],
};

// One stand-in FluxOS node answering both questions the selection asks:
// /apps/listrunningapps (is it serving?) and /apps/heldcomponents (is it holding?).
function serveNode({ running = [], held = [], heldStatus = 200 } = {}) {
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/apps/heldcomponents')) {
      if (heldStatus !== 200) {
        res.writeHead(heldStatus, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'error', data: { message: 'Not Found' } }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'success', data: held }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'success', data: running }));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

const addr = (server) => `127.0.0.1:${server.address().port}`;

describe('g: app primary selection', () => {
  const servers = [];

  const node = async (opts) => {
    const server = await serveNode(opts);
    servers.push(server);
    return addr(server);
  };

  afterEach(() => {
    while (servers.length) servers.pop().close();
    resetGStickyState(zizySpec.name);
  });

  // One retry: the production backoff is 3 attempts three seconds apart, and this
  // suite is proving ordering, not the retry ladder.
  //
  // Driven through selectGPrimaries, which is what the pass runs. The single-app
  // entry point this used to call stopped being called by production and then
  // silently missed a fix, so it is gone.
  const select = async (ips) => {
    const chosen = await selectGPrimaries([zizySpec], new Map([[zizySpec.name, ips]]), { retries: 1 });
    return chosen.get(zizySpec.name);
  };

  it('keeps a running master as primary', async () => {
    const master = await node({ running: [{ Names: ['/fluxapp_zizy'] }] });
    expect(await select([master])).to.equal(master);
  });

  // THE SAFETY PROPERTY. A node actually serving the app must always outrank one
  // that is merely holding it, whatever order they are considered in. If the held
  // check ever short-circuits ahead of the running checks, this pins the domain to
  // a stopped container while a live one is sitting right there.
  it('prefers a node that is running the app over one that is only holding it', async () => {
    const holder = await node({ running: [], held: ['fluxapp_zizy'] });
    const runner = await node({ running: [{ Names: ['/fluxapp_zizy'] }] });
    expect(await select([holder, runner])).to.equal(runner);
  });

  // The point of the change: an operator-stopped master must not fall out of FDM.
  // Returning null here is what un-names the primary and lets a stop/start cycle
  // land the app on another node's copy of the syncthing volume.
  it('keeps an operator-stopped master as primary when nothing is running', async () => {
    const holder = await node({ running: [], held: ['fluxapp_zizy'] });
    const idle = await node({ running: [], held: [] });
    expect(await select([holder, idle])).to.equal(holder);
  });

  // Named once and then preserved, so a holder that goes quiet on a later pass is
  // not swapped for another WHILE THIS PROCESS LIVES. It is deliberately not
  // phrased as a restart guarantee: the sticky is module state and a restart
  // starts empty, so the deterministic candidate order decides again from
  // scratch. See the note in decideHeldPrimary.
  it('records the held master as sticky, so a later pass does not re-derive it', async () => {
    const holder = await node({ running: [], held: ['fluxapp_zizy'] });
    await select([holder]);
    expect(getGStickyIp(zizySpec.name)).to.equal(holder);
  });

  it('prefers the previous primary when more than one node reports holding', async () => {
    // A global appstop locks every instance, so several nodes answer "held" and
    // only the sticky says which one owned the writable copy.
    const other = await node({ running: [], held: ['fluxapp_zizy'] });
    const previousPrimary = await node({ running: [], held: ['fluxapp_zizy'] });
    setGStickyState(zizySpec.name, previousPrimary, 0);
    expect(await select([other, previousPrimary])).to.equal(previousPrimary);
  });

  it('drops the app when nothing is running and nothing is held', async () => {
    const idleA = await node({ running: [], held: [] });
    const idleB = await node({ running: [], held: [] });
    expect(await select([idleA, idleB])).to.equal(null);
  });

  // The mixed-version window: most of the fleet has no /apps/heldcomponents until
  // it upgrades. That must leave the existing behaviour untouched.
  it('drops the app when no node is old enough to answer what it holds', async () => {
    const oldA = await node({ running: [], heldStatus: 404 });
    const oldB = await node({ running: [], heldStatus: 404 });
    expect(await select([oldA, oldB])).to.equal(null);
  });

  it('does not treat a node holding only the non-g: component as the primary', async () => {
    const mysqlOnly = await node({ running: [], held: ['fluxmysql_zizy'] });
    expect(await select([mysqlOnly])).to.equal(null);
  });
});

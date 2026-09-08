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
  // Mutable, so a test can have a node start or stop serving the app between
  // passes - which is the only way to exercise a primary actually moving.
  const state = { running, held, heldStatus };
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/apps/heldcomponents')) {
      if (state.heldStatus !== 200) {
        res.writeHead(state.heldStatus, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'error', data: { message: 'Not Found' } }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'success', data: state.held }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'success', data: state.running }));
  });
  server.state = state;
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

const addr = (server) => `127.0.0.1:${server.address().port}`;

describe('g: app primary selection', () => {
  const servers = [];

  const nodeServer = async (opts) => {
    const server = await serveNode(opts);
    servers.push(server);
    return server;
  };
  const node = async (opts) => addr(await nodeServer(opts));

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

  // warn.log is the only log that keeps real history, so what goes in it has to
  // be events, not states. An operator-stopped app is a state: the running phase
  // releases the sticky and the held phase re-pins the very same node, on every
  // pass, for as long as the app stays stopped - roughly 28 apps on the dev FDM
  // against a 25-64s cadence. Only a primary that actually changed is reported.
  //
  // Resetting the failure counter on the held path would silence it too, and must
  // not: it re-arms the confirmation guard, so the running phase keeps the
  // stopped node and the candidate sweep - the phase that finds a node which has
  // since started running the app - never runs. That is three passes to move
  // where there is one. The last two cases pin both halves.
  describe('what reaches warn.log', () => {
    // eslint-disable-next-line global-require
    const log = require('../src/lib/log');
    const G_APP_MIN_CONFIRMATIONS = 3;
    let warns = [];
    let realWarn;

    beforeEach(() => {
      warns = [];
      realWarn = log.warn;
      log.warn = (m) => { warns.push(String(m)); };
    });
    afterEach(() => { log.warn = realWarn; });

    it('says nothing every pass about an operator-stopped app whose primary is unchanged', async () => {
      const holder = await node({ running: [], held: ['fluxapp_zizy'] });
      const idle = await node({ running: [], held: [] });
      // Healthy long enough ago that the grace and the confirmations are both
      // spent, which is the steady state after a stop.
      setGStickyState(zizySpec.name, holder, domainService.monotonicMs() - 600_000);
      // Spend the two confirmations the running phase owes a primary.
      await select([holder, idle]);
      await select([holder, idle]);
      warns = [];
      for (let pass = 0; pass < 4; pass += 1) {
        // eslint-disable-next-line no-await-in-loop
        expect(await select([holder, idle])).to.equal(holder);
      }
      expect(warns).to.deep.equal([]);
    });

    it('reports the move, once, when the primary actually changes', async () => {
      const first = await nodeServer({ running: [{ Names: ['/fluxapp_zizy'] }] });
      const second = await nodeServer({ running: [] });
      expect(await select([addr(first), addr(second)])).to.equal(addr(first));
      warns = [];

      // The primary stops serving it and the other node picks it up. Neither is
      // holding it, so this is the running path, start to finish.
      first.state.running = [];
      second.state.running = [{ Names: ['/fluxapp_zizy'] }];
      // Last healthy well outside the 90s grace, which a test running in
      // milliseconds cannot otherwise leave. The confirmations are spent one
      // pass at a time below - release needs BOTH.
      setGStickyState(zizySpec.name, addr(first), domainService.monotonicMs() - 600_000);

      for (let pass = 1; pass < G_APP_MIN_CONFIRMATIONS; pass += 1) {
        // eslint-disable-next-line no-await-in-loop
        expect(await select([addr(first), addr(second)])).to.equal(addr(first));
      }
      expect(await select([addr(first), addr(second)])).to.equal(addr(second));

      const moves = warns.filter((w) => w.includes('PRIMARY MOVED'));
      expect(moves).to.have.lengthOf(1);
      expect(moves[0]).to.contain(addr(first)).and.to.contain(addr(second));
    });

    // A held app is not pinned: the instant a node starts running it, the very
    // next pass moves.
    // Exclusion is reported on its edges too: an app with no locations stays
    // that way for as long as it is dead, and only "went dark" and "came back"
    // carry anything.
    it('reports an app going dark and coming back, and nothing in between', () => {
      const { reportExclusion } = domainService;
      for (let pass = 0; pass < 4; pass += 1) reportExclusion('G', zizySpec.name, true);
      expect(warns).to.have.lengthOf(1);
      expect(warns[0]).to.contain('is excluded');

      for (let pass = 0; pass < 4; pass += 1) reportExclusion('G', zizySpec.name, false);
      expect(warns).to.have.lengthOf(2);
      expect(warns[1]).to.contain('no longer excluded');

      reportExclusion('G', zizySpec.name, true);
      expect(warns).to.have.lengthOf(3);
    });

    it('moves a held app to a node that starts running it, on the next pass', async () => {
      // From the third pass on - once the confirmations are spent, which is the
      // steady state of an operator-stopped app. Swept over its length because
      // the failure it guards against is cyclic: a running phase that keeps the
      // stopped node for two passes out of every three still moves on the third,
      // so a single warm-up length can pass by luck. Every length must move on
      // the next pass, not just the convenient one.
      for (let held = 3; held <= 8; held += 1) {
        resetGStickyState(zizySpec.name);
        // eslint-disable-next-line no-await-in-loop
        const holder = await nodeServer({ running: [], held: ['fluxapp_zizy'] });
        // eslint-disable-next-line no-await-in-loop
        const other = await nodeServer({ running: [], held: [] });
        setGStickyState(zizySpec.name, addr(holder), domainService.monotonicMs() - 600_000);
        for (let pass = 0; pass < held; pass += 1) {
          // eslint-disable-next-line no-await-in-loop
          expect(await select([addr(holder), addr(other)])).to.equal(addr(holder));
        }

        // `other` starts serving it. The NEXT pass moves - never the third.
        other.state.running = [{ Names: ['/fluxapp_zizy'] }];
        // eslint-disable-next-line no-await-in-loop
        expect(await select([addr(holder), addr(other)]), `after ${held} held pass(es)`)
          .to.equal(addr(other));
      }
    });
  });
});

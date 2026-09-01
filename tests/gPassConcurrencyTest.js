/* eslint-disable func-names */
const chai = require('chai');
const http = require('http');

const { expect } = chai;
const domainService = require('../src/services/domainService');
const log = require('../src/lib/log');

const {
  selectGPrimaries, setGStickyState, resetGStickyState, getGStickyIp,
  monotonicMs, resetNodeReachability,
} = domainService;

const spec = (name) => ({
  version: 8,
  name,
  compose: [
    { name: 'app', containerData: 'g:/appdata' },
    { name: 'db', containerData: '/var/lib/db' },
  ],
});

/**
 * A stand-in FluxOS node that counts what it was asked, so a test can assert on
 * how many times a question was put to it rather than only on the answer.
 */
function serveNode({
  running = [], held = [], heldStatus = 200, runningStatus = 200, reset = false,
  blackhole = false,
} = {}) {
  const hits = { running: 0, held: 0 };
  const state = {
    running, held, reset, blackhole, slowMs: 0,
  };
  const heldSockets = [];
  const server = http.createServer((req, res) => {
    const isHeld = req.url.startsWith('/apps/heldcomponents');
    hits[isHeld ? 'held' : 'running'] += 1;
    if (state.slowMs) {
      // Alive, just loaded. The interesting case is a node slower than the
      // known-bad budget but well inside the first-contact one.
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: 'success',
          data: isHeld ? state.held : state.running.map((n) => ({ Names: [`/${n}`] })),
        }));
      }, state.slowMs);
      return;
    }
    if (state.blackhole) {
      // The expensive shape: the connection is ACCEPTED and then nothing is ever
      // sent. `reset` fails in milliseconds; this one costs the full timeout,
      // which is what turned one node into a 126s pass.
      heldSockets.push(req.socket);
      return;
    }
    if (state.reset) {
      // Accepts the connection, then vanishes: no status line, so no answer.
      req.socket.destroy();
      return;
    }
    const status = isHeld ? heldStatus : runningStatus;
    if (status !== 200) {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'error', data: { message: 'nope' } }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'success',
      data: isHeld ? state.held : state.running.map((n) => ({ Names: [`/${n}`] })),
    }));
  });
  server.hits = hits;
  server.state = state;
  server.releaseHeld = () => { while (heldSockets.length) heldSockets.pop().destroy(); };
  return new Promise((resolve) => { server.listen(0, '127.0.0.1', () => resolve(server)); });
}

const addr = (s) => `127.0.0.1:${s.address().port}`;

describe('g: pass - probing cost and what silence means', () => {
  const servers = [];
  const names = [];
  const node = async (opts) => { const s = await serveNode(opts); servers.push(s); return s; };

  afterEach(() => {
    while (servers.length) {
      const s = servers.pop();
      if (s.releaseHeld) s.releaseHeld();
      s.close();
    }
    while (names.length) resetGStickyState(names.pop());
    resetNodeReachability();
  });
  const track = (n) => { names.push(n); return n; };

  // One app, driven through selectGPrimaries - the pass production runs. There is
  // no single-app entry point any more: there was one, it stopped being called,
  // and it quietly missed a fix because nothing exercised it.
  const selectFor = async (ips, name, options) => {
    const chosen = await selectGPrimaries([spec(name)], new Map([[name, ips]]), options);
    return chosen.get(name);
  };

  // One attempt: these cases prove ordering and grace behaviour, not the ladder,
  // and the production backoff would add seconds per assertion.
  const select = (ips, name) => selectFor(ips, name, { retries: 1, delayMs: 5 });

  // THE COST PROPERTY. A node that answered has settled the question. Re-asking
  // it three seconds later cannot produce a better answer, and on fdm-eu-1-03
  // doing so was 390s of a 479s pass: 65 nodes each replied in under a second
  // that they were not running the component, and each cost six seconds of sleep.
  it('asks a node that answered "not running" exactly once, not once per retry', async () => {
    const name = track('zizy');
    const idle = await node({ running: [] });
    const started = Date.now();
    const chosen = await selectFor([addr(idle)], name);
    expect(chosen).to.equal(null);
    expect(idle.hits.running).to.equal(1);
    // No backoff was paid: three attempts three seconds apart would be >= 6s.
    expect(Date.now() - started).to.be.below(3000);
  });

  // The retry ladder still exists - it just waits on the case it was written for:
  // a node that never replied. Nothing came back, so nothing has been settled.
  it('retries a node that never replies', async () => {
    const name = track('zizy');
    const silent = await node({ reset: true });
    await selectFor([addr(silent)], name, { retries: 3, delayMs: 5 });
    expect(silent.hits.running).to.equal(3);
  });

  // A STATUS IS AN ANSWER. Most of the fleet cannot serve /apps/heldcomponents
  // until flux#1777 ships, and answers 404 - it is alive, and it will still be
  // too old three seconds from now, so the ladder buys nothing. Measured on the
  // dev FDM before this: 61 nodes taken through the full ladder every pass.
  it('does not retry a node that answered with a status, even an error one', async () => {
    const name = track('zizy');
    const tooOld = await node({ running: [], heldStatus: 404 });
    await selectFor([addr(tooOld)], name, { retries: 3, delayMs: 5 });
    expect(tooOld.hits.held).to.equal(1);
  });

  // One question per node per pass, however many apps that node is a candidate
  // for. The old shape re-asked the same node for every app in turn.
  it('asks each node once per pass however many apps it is a candidate for', async () => {
    const shared = await node({ running: ['fluxapp_a1'] });
    const apps = ['a1', 'a2', 'a3'].map((n) => spec(track(n)));
    const locations = new Map(apps.map((a) => [a.name, [addr(shared)]]));
    const chosen = await selectGPrimaries(apps, locations, { retries: 1 });
    expect(chosen.get('a1')).to.equal(addr(shared));
    expect(chosen.get('a2')).to.equal(null);
    expect(chosen.get('a3')).to.equal(null);
    expect(shared.hits.running).to.equal(1);
  });

  // A healthy app costs ONE probe - the node it is already on. The other
  // candidates only matter once its primary stops answering, and asking them
  // anyway was 900 probes a pass where 334 would do. At a 25s cadence that
  // difference is the whole load story.
  it('does not probe the other candidates while the remembered primary answers', async () => {
    const name = track('zizy');
    const primary = await node({ running: [`fluxapp_${name}`] });
    const standby = await node({ running: [] });
    setGStickyState(name, addr(primary), undefined);
    // Seed the sticky, then measure a steady-state pass.
    const apps = [spec(name)];
    const locations = new Map([[name, [addr(primary), addr(standby)]]]);
    await selectGPrimaries(apps, locations, { retries: 1 });
    primary.hits.running = 0;
    standby.hits.running = 0;
    const chosen = await selectGPrimaries(apps, locations, { retries: 1 });
    expect(chosen.get(name)).to.equal(addr(primary));
    expect(primary.hits.running).to.equal(1);
    expect(standby.hits.running).to.equal(0);
  });

  // ...and the wider sweep still happens the moment it stops answering.
  it('sweeps the other candidates once the remembered primary stops answering', async () => {
    const name = track('zizy');
    const standby = await node({ running: [`fluxapp_${name}`] });
    const dead = await node({ running: [] });
    setGStickyState(name, addr(dead), undefined);
    const chosen = await selectGPrimaries([spec(name)], new Map([[name, [addr(dead), addr(standby)]]]), { retries: 1 });
    expect(chosen.get(name)).to.equal(addr(standby));
  });

  // THE GRACE. An established primary that fails one check is kept - that is the
  // branch that absorbs a blip, and until now nothing exercised it: every test
  // seeded lastHealthy as 0 or undefined, which skips it entirely.
  it('keeps an established primary that fails a single check', async () => {
    const name = track('zizy');
    const primary = await node({ running: [] });
    const other = await node({ running: [`fluxapp_${name}`] });
    setGStickyState(name, addr(primary), monotonicMs());
    expect(await select([addr(primary), addr(other)], name)).to.equal(addr(primary));
  });

  // THE CONFIRMATION COUNT, which the grace alone does not give. Cadence is
  // max(floor, how long the pass took), so one unreachable node stretching a
  // pass past 90s would otherwise let a SINGLE failed check move a domain. The
  // count has to be a property of the code, not of how fast the pass ran.
  it('does not move an established primary on one failed check, even once the grace has expired', async () => {
    const name = track('zizy');
    const primary = await node({ running: [] });
    const other = await node({ running: [`fluxapp_${name}`] });
    const ips = [addr(primary), addr(other)];
    // Healthy long ago: the 90s grace is already spent.
    setGStickyState(name, addr(primary), monotonicMs() - (200 * 1000));

    expect(await select(ips, name)).to.equal(addr(primary)); // failure 1 of 3
    expect(await select(ips, name)).to.equal(addr(primary)); // failure 2 of 3
    expect(await select(ips, name)).to.equal(addr(other)); // third confirms it
  });

  // ...and a primary that recovers in between starts the count again.
  it('resets the confirmation count when the primary answers again', async () => {
    const name = track('zizy');
    const primary = await node({ running: [] });
    const other = await node({ running: [`fluxapp_${name}`] });
    const ips = [addr(primary), addr(other)];
    setGStickyState(name, addr(primary), monotonicMs() - (200 * 1000));

    await select(ips, name); // failure 1
    await select(ips, name); // failure 2
    primary.state.running = [`fluxapp_${name}`]; // it comes back
    expect(await select(ips, name)).to.equal(addr(primary));
    primary.state.running = []; // and fails again
    expect(await select(ips, name)).to.equal(addr(primary)); // failure 1 again, not 3
  });

  // An explicit "I am not holding it" retracts the claim. Without this the
  // confirmation outlives the withdrawal and a later silence reinstates it.
  it('does not reinstate a holder that explicitly said it was not holding', async () => {
    const name = track('zizy');
    const holder = await node({ running: [], held: [`fluxapp_${name}`] });
    const idle = await node({ running: [], held: [] });
    const ips = [addr(holder), addr(idle)];

    // Pass 1: it holds, and is recorded.
    setGStickyState(name, addr(holder), 0);
    expect(await select(ips, name)).to.equal(addr(holder));

    // Pass 2: it retracts.
    holder.state.held = [];
    expect(await select(ips, name)).to.equal(null);

    // Pass 3: it goes quiet. The retracted claim must not bring it back.
    holder.state.reset = true;
    expect(await select(ips, name)).to.equal(null);
  });

  // THE SAFETY PROPERTY for the held fallback. A holder that cannot answer has
  // not said it stopped holding. Walking on to the next node that reports held
  // is how one dropped packet moves a domain - and the node most likely to
  // answer HELD spuriously is one carrying a stale operator-stop lock, which is
  // also the node FluxOS's election will never pick.
  it('keeps an unreachable incumbent holder rather than promoting another holder', async () => {
    const name = track('zizy');
    const holder = await node({ running: [], held: [`fluxapp_${name}`] });
    const other = await node({ running: [], held: [`fluxapp_${name}`] });
    const ips = [addr(holder), addr(other)];

    // Pass 1: the holder answers, and is recorded as the primary.
    setGStickyState(name, addr(holder), 0);
    expect(await selectFor(ips, name, { retries: 1 })).to.equal(addr(holder));

    // Pass 2: the holder cannot answer. The other node still claims to hold it.
    const holderAddr = addr(holder);
    holder.close();
    servers.splice(servers.indexOf(holder), 1);
    expect(await selectFor(ips, name, { retries: 1, delayMs: 5 })).to.equal(holderAddr);
    expect(getGStickyIp(name)).to.equal(holderAddr);
  });

  // The incumbent is kept on silence, not forever. An explicit "I am not holding
  // it" releases it immediately - that is an answer, not an absence.
  it('releases the incumbent to another holder when it explicitly says it is not holding', async () => {
    const name = track('zizy');
    const holder = await node({ running: [], held: [] });
    const other = await node({ running: [], held: [`fluxapp_${name}`] });
    setGStickyState(name, addr(holder), 0);
    const chosen = await selectFor([addr(holder), addr(other)], name, { retries: 1 });
    expect(chosen).to.equal(addr(other));
  });
  // ---------------------------------------------------------------------------
  // The blackhole. A node that ACCEPTS the connection and then says nothing costs
  // the full timeout on every attempt, and it is the shape that turned one node
  // into a 126s pass: 3 phases x (12s + 3s + 12s + 3s + 12s) = 126s, against 128.25s
  // measured on fdm-eu-2-02. Removing the x3 left the 42s. These three close it.
  //
  // ---------------------------------------------------------------------------

  // A node that failed a WHOLE ladder has been asked and answered - with silence.
  // Asking it three more times 25 seconds later cannot produce a better answer,
  // and on the dev FDM that was paid 24 times in 10 minutes for the same node. It
  // is still asked ONCE every pass, so a node that recovers is seen within one.
  it('does not put a node that failed a whole ladder through it again next pass', async function () {
    this.timeout(60000);
    const name = track('zizy');
    const silent = await node({ reset: true });
    const opts = { retries: 3, delayMs: 5 };
    await selectFor([addr(silent)], name, opts);
    const firstPass = silent.hits.running;
    expect(firstPass).to.equal(3);
    await selectFor([addr(silent)], name, opts);
    expect(silent.hits.running - firstPass).to.equal(1);
  });

  // A node that recovers must not stay written off. It is asked every pass, so the
  // memo costs it one pass of being a non-candidate, never more.
  //
  // This one passes on 32912bb too - there is no memo there to get stuck in. It
  // pins the property the memo must not break, rather than a regression.
  it('takes a written-off node back the moment it answers again', async function () {
    this.timeout(60000);
    const name = track('zizy');
    const silent = await node({ reset: true });
    const opts = { retries: 2, delayMs: 5 };
    await selectFor([addr(silent)], name, opts);
    silent.state.reset = false;
    silent.state.running = [`fluxapp_${name}`];
    const chosen = await selectFor([addr(silent)], name, opts);
    expect(chosen).to.equal(addr(silent));
  });

  // A node that is down stays down for thousands of passes. Saying so on each one
  // would bury the moment it changed, which is the only part anybody reads back -
  // and the retry line has to name the node, or a count cannot tell you whether
  // one node is failing every pass or a different one each time.
  it('logs the write-off once on the transition, not on every pass', async function () {
    this.timeout(60000);
    const name = track('zizy');
    const silent = await node({ reset: true });
    const warns = [];
    const infos = [];
    const realWarn = log.warn;
    const realInfo = log.info;
    log.warn = (m) => { warns.push(String(m)); };
    log.info = (m) => { infos.push(String(m)); };
    try {
      const opts = { retries: 2, delayMs: 5 };
      await selectFor([addr(silent)], name, opts);
      await selectFor([addr(silent)], name, opts);
      await selectFor([addr(silent)], name, opts);
      const writtenOff = warns.filter((m) => m.includes('written off'));
      expect(writtenOff).to.have.lengthOf(1);
      expect(writtenOff[0]).to.contain(addr(silent));
      // And the retry line names who it is waiting on.
      const retries = infos.filter((m) => m.includes('could not be read'));
      expect(retries.length).to.be.above(0);
      expect(retries[0]).to.contain(addr(silent));
      // Recovery closes the pair, in the same file.
      silent.state.reset = false;
      silent.state.running = [`fluxapp_${name}`];
      await selectFor([addr(silent)], name, opts);
      expect(warns.filter((m) => m.includes('answering again'))).to.have.lengthOf(1);
    } finally {
      log.warn = realWarn;
      log.info = realInfo;
    }
  });

  // The short budget is a trap of its own if it is the ONLY budget a written-off
  // node ever gets: a node that answers in 3s - alive, just loaded - would fail a
  // 2s probe every pass forever, written off on the strength of a timeout chosen
  // because we already believed it was dead. It gets the full one back periodically.
  it('gives a written-off node the full timeout again on its recheck, so a slow node can return', async function () {
    this.timeout(60000);
    const name = track('zizy');
    const slow = await node({ blackhole: true, running: [`fluxapp_${name}`] });
    const opts = {
      retries: 1, delayMs: 5, timeoutMs: 900, knownBadTimeoutMs: 100,
    };
    await selectFor([addr(slow)], name, { ...opts, unreachableRecheckMs: 999999 });
    // Now it answers - but slower than the known-bad budget allows.
    slow.state.blackhole = false;
    slow.state.slowMs = 350;
    const stillWrittenOff = await selectFor([addr(slow)], name, { ...opts, unreachableRecheckMs: 999999 });
    expect(stillWrittenOff).to.equal(null);
    // On the recheck it gets the full budget, and answers inside it.
    const recovered = await selectFor([addr(slow)], name, { ...opts, unreachableRecheckMs: 0 });
    expect(recovered).to.equal(addr(slow));
  });

  // The first contact keeps real headroom - a node that is merely slow must not be
  // mistaken for one that is gone. A node we ALREADY believe is down does not: that
  // timeout is paid every pass forever. Measured on the fleet, 306 of 306 primaries
  // answered inside 608ms, so 2s is still 3x the slowest real answer.
  it('asks a known-bad node with a short timeout, not the full one', async function () {
    this.timeout(60000);
    const name = track('zizy');
    const silent = await node({ blackhole: true });
    const opts = {
      retries: 1, delayMs: 5, timeoutMs: 800, knownBadTimeoutMs: 150,
    };
    await selectFor([addr(silent)], name, opts);
    const started = Date.now();
    await selectFor([addr(silent)], name, opts);
    expect(Date.now() - started).to.be.below(600);
  });

  // Cadence is max(floor, pass duration), and the confirmations a primary gets
  // before it is moved used to be floor(90000 / cadence). Counting them fixed the
  // arithmetic; this makes the premise structural. A pass that cannot outrun its
  // deadline cannot stretch the cadence, whatever the fleet does.
  it('abandons a pass at its deadline rather than letting one silent node set the cadence', async function () {
    this.timeout(60000);
    const name = track('zizy');
    const silent = await node({ blackhole: true });
    const started = Date.now();
    await selectFor([addr(silent)], name, {
      retries: 3, delayMs: 100, timeoutMs: 5000, deadlineMs: 700,
    });
    expect(Date.now() - started).to.be.below(1500);
  });
});

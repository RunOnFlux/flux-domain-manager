/* eslint-disable func-names */
const chai = require('chai');
const http = require('http');

const { expect } = chai;
const domainService = require('../src/services/domainService');

const {
  selectIPforG, selectGPrimaries, setGStickyState, resetGStickyState, getGStickyIp,
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
} = {}) {
  const hits = { running: 0, held: 0 };
  const server = http.createServer((req, res) => {
    const isHeld = req.url.startsWith('/apps/heldcomponents');
    hits[isHeld ? 'held' : 'running'] += 1;
    if (reset) {
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
      data: isHeld ? held : running.map((n) => ({ Names: [`/${n}`] })),
    }));
  });
  server.hits = hits;
  return new Promise((resolve) => { server.listen(0, '127.0.0.1', () => resolve(server)); });
}

const addr = (s) => `127.0.0.1:${s.address().port}`;

describe('g: pass - probing cost and what silence means', () => {
  const servers = [];
  const names = [];
  const node = async (opts) => { const s = await serveNode(opts); servers.push(s); return s; };

  afterEach(() => {
    while (servers.length) servers.pop().close();
    while (names.length) resetGStickyState(names.pop());
  });
  const track = (n) => { names.push(n); return n; };

  // THE COST PROPERTY. A node that answered has settled the question. Re-asking
  // it three seconds later cannot produce a better answer, and on fdm-eu-1-03
  // doing so was 390s of a 479s pass: 65 nodes each replied in under a second
  // that they were not running the component, and each cost six seconds of sleep.
  it('asks a node that answered "not running" exactly once, not once per retry', async () => {
    const name = track('zizy');
    const idle = await node({ running: [] });
    const started = Date.now();
    const chosen = await selectIPforG([addr(idle)], spec(name));
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
    await selectIPforG([addr(silent)], spec(name), { retries: 3, delayMs: 5 });
    expect(silent.hits.running).to.equal(3);
  });

  // A STATUS IS AN ANSWER. Most of the fleet cannot serve /apps/heldcomponents
  // until flux#1777 ships, and answers 404 - it is alive, and it will still be
  // too old three seconds from now, so the ladder buys nothing. Measured on the
  // dev FDM before this: 61 nodes taken through the full ladder every pass.
  it('does not retry a node that answered with a status, even an error one', async () => {
    const name = track('zizy');
    const tooOld = await node({ running: [], heldStatus: 404 });
    await selectIPforG([addr(tooOld)], spec(name), { retries: 3, delayMs: 5 });
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
    expect(await selectIPforG(ips, spec(name), { retries: 1 })).to.equal(addr(holder));

    // Pass 2: the holder cannot answer. The other node still claims to hold it.
    const holderAddr = addr(holder);
    holder.close();
    servers.splice(servers.indexOf(holder), 1);
    expect(await selectIPforG(ips, spec(name), { retries: 1, delayMs: 5 })).to.equal(holderAddr);
    expect(getGStickyIp(name)).to.equal(holderAddr);
  });

  // The incumbent is kept on silence, not forever. An explicit "I am not holding
  // it" releases it immediately - that is an answer, not an absence.
  it('releases the incumbent to another holder when it explicitly says it is not holding', async () => {
    const name = track('zizy');
    const holder = await node({ running: [], held: [] });
    const other = await node({ running: [], held: [`fluxapp_${name}`] });
    setGStickyState(name, addr(holder), 0);
    const chosen = await selectIPforG([addr(holder), addr(other)], spec(name), { retries: 1 });
    expect(chosen).to.equal(addr(other));
  });
});

const chai = require('chai');
const http = require('http');
const config = require('config');
const { createAppCountReference } = require('../src/lib/appCountReference');
const { hasManyApps } = require('../src/services/application/checks');

const { expect } = chai;

describe('app count reference', () => {
  it('returns the median of the latest count per node, the new one included', () => {
    const reference = createAppCountReference(1_000);
    expect(reference.observe('a', 1900, 0)).to.deep.equal({ median: 1900, nodes: 1 });
    expect(reference.observe('b', 400, 10)).to.deep.equal({ median: 1150, nodes: 2 });
    expect(reference.observe('c', 1950, 20)).to.deep.equal({ median: 1900, nodes: 3 });
  });

  it('gives a node one vote however often it reports', () => {
    const reference = createAppCountReference(1_000);
    reference.observe('a', 1900, 0);
    reference.observe('b', 1910, 0);
    for (let i = 1; i <= 20; i += 1) reference.observe('inflated', 5000, i);
    expect(reference.observe('c', 1920, 30)).to.deep.equal({ median: 1915, nodes: 4 });
  });

  it('keeps only the latest count of a node', () => {
    const reference = createAppCountReference(1_000);
    reference.observe('a', 5000, 0);
    expect(reference.observe('a', 1900, 10)).to.deep.equal({ median: 1900, nodes: 1 });
  });

  it('drops a node not seen within the window', () => {
    const reference = createAppCountReference(1_000);
    reference.observe('a', 1900, 0);
    expect(reference.observe('b', 1200, 999)).to.deep.equal({ median: 1550, nodes: 2 });
    expect(reference.observe('b', 1200, 1_000)).to.deep.equal({ median: 1200, nodes: 1 });
  });
});

// One local node answering /apps/globalappsspecifications with however many apps the test sets.
async function startNode() {
  const state = { data: [] };
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'success', data: state.data }));
  });
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const serve = (count) => { state.data = Array.from({ length: count }, (_, i) => ({ name: `app${i}` })); };
  const serveRaw = (data) => { state.data = data; };
  return {
    server, serve, serveRaw, port: server.address().port,
  };
}

describe('main balancer node app check', () => {
  const { windowMs, minNodes, maxDeviationRatio } = config.guards.mainNode;
  // The band around a median of 1929.
  const lowest = Math.ceil(1929 * (1 - maxDeviationRatio));
  const highest = Math.floor(1929 * (1 + maxDeviationRatio));
  const nodes = [];
  let reference;

  const check = (node, now) => hasManyApps('127.0.0.1', node.port, { now, reference });

  // Brings the window up to minNodes with nodes listing `count` apps.
  async function warmUp(count) {
    for (let i = 0; i < minNodes; i += 1) {
      nodes[i].serve(count);
      // eslint-disable-next-line no-await-in-loop
      expect(await check(nodes[i], 0)).to.equal(true);
    }
  }

  before(async () => {
    for (let i = 0; i < minNodes * 2; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      nodes.push(await startNode());
    }
  });

  after(() => { nodes.forEach((node) => node.server.close()); });

  beforeEach(() => { reference = createAppCountReference(windowMs); });

  it('accepts any non-empty list until minNodes nodes have reported', async () => {
    for (let i = 0; i < minNodes - 2; i += 1) {
      nodes[i].serve(1929);
      // eslint-disable-next-line no-await-in-loop
      await check(nodes[i], 0);
    }
    const short = nodes[minNodes - 2];
    short.serve(1);
    expect(await check(short, 1)).to.equal(true);
    nodes[minNodes - 1].serve(1929);
    await check(nodes[minNodes - 1], 2);
    expect(await check(short, 3)).to.equal(false);
  });

  it('refuses a node more than maxDeviationRatio below the median', async () => {
    await warmUp(1929);
    const node = nodes[minNodes];
    node.serve(lowest);
    expect(await check(node, 1)).to.equal(true);
    node.serve(lowest - 1);
    expect(await check(node, 2)).to.equal(false);
  });

  it('refuses a node more than maxDeviationRatio above the median', async () => {
    await warmUp(1929);
    const node = nodes[minNodes];
    node.serve(highest);
    expect(await check(node, 1)).to.equal(true);
    node.serve(highest + 1);
    expect(await check(node, 2)).to.equal(false);
  });

  it('keeps honest nodes and refuses an inflated node checked every pass', async () => {
    await warmUp(1929);
    const inflated = nodes[minNodes];
    inflated.serve(5000);
    for (let pass = 1; pass <= 20; pass += 1) {
      // eslint-disable-next-line no-await-in-loop
      expect(await check(inflated, pass)).to.equal(false);
    }
    for (let i = 0; i < minNodes; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      expect(await check(nodes[i], 21)).to.equal(true);
    }
  });

  it('refuses a node with an empty or malformed list', async () => {
    const node = nodes[0];
    node.serve(0);
    expect(await check(node, 0)).to.equal(false);
    node.serveRaw({ message: 'db not ready' });
    expect(await check(node, 1)).to.equal(false);
  });

  it('gives no vote to a node with an empty or malformed list', async () => {
    await warmUp(1929);
    const failing = nodes.slice(minNodes);
    for (let i = 0; i < failing.length; i += 1) {
      if (i % 2) failing[i].serve(0);
      else failing[i].serveRaw({ message: 'db not ready' });
      // eslint-disable-next-line no-await-in-loop
      expect(await check(failing[i], 1)).to.equal(false);
    }
    expect(await check(nodes[0], 2)).to.equal(true);
  });

  it('follows the network as nodes report a new count', async () => {
    await warmUp(1929);
    for (let i = 0; i < minNodes / 2 + 1; i += 1) {
      nodes[i].serve(1000);
      // eslint-disable-next-line no-await-in-loop
      await check(nodes[i], 1);
    }
    nodes[minNodes].serve(1000);
    expect(await check(nodes[minNodes], 2)).to.equal(true);
  });

  it('drops nodes that have not reported within the window', async () => {
    await warmUp(1929);
    const fresh = nodes.slice(minNodes);
    fresh.forEach((node) => node.serve(1000));
    expect(await check(fresh[0], windowMs - 1)).to.equal(false);
    for (let i = 1; i < minNodes; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await check(fresh[i], windowMs);
    }
    expect(await check(fresh[0], windowMs + 1)).to.equal(true);
  });
});

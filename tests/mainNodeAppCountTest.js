const chai = require('chai');
const http = require('http');
const config = require('config');
const { createAppCountReference } = require('../src/lib/appCountReference');
const { hasManyApps } = require('../src/services/application/checks');

const { expect } = chai;

describe('app count reference', () => {
  it('returns the largest count within the window, the new one included', () => {
    const reference = createAppCountReference(1_000);
    expect(reference.observe(1900, 0)).to.equal(1900);
    expect(reference.observe(400, 10)).to.equal(1900);
    expect(reference.observe(1950, 20)).to.equal(1950);
  });

  it('lets a count age out of the window', () => {
    const reference = createAppCountReference(1_000);
    reference.observe(1900, 0);
    expect(reference.observe(1200, 999)).to.equal(1900);
    expect(reference.observe(1200, 1_000)).to.equal(1200);
  });
});

// Answers /apps/globalappsspecifications with however many apps the test sets.
async function serveAppList() {
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
  const { windowMs } = config.guards.mainNode;
  let node;
  // Each test runs in its own window, so counts from one test never reach another.
  let base = 0;

  beforeEach(async () => {
    node = await serveAppList();
    base += windowMs * 10;
  });

  afterEach(() => { node.server.close(); });

  it('accepts a node whatever apps it lists, with no app named in config', async () => {
    node.serve(1929);
    expect(await hasManyApps('127.0.0.1', node.port, base)).to.equal(true);
  });

  it('refuses a node listing more than 30% fewer apps than the largest recent list', async () => {
    node.serve(1929);
    await hasManyApps('127.0.0.1', node.port, base);
    node.serve(1351);
    expect(await hasManyApps('127.0.0.1', node.port, base + 1)).to.equal(true);
    node.serve(1350);
    expect(await hasManyApps('127.0.0.1', node.port, base + 2)).to.equal(false);
  });

  it('refuses a node with an empty or malformed list', async () => {
    node.serve(0);
    expect(await hasManyApps('127.0.0.1', node.port, base)).to.equal(false);
    node.serveRaw({ message: 'db not ready' });
    expect(await hasManyApps('127.0.0.1', node.port, base + 1)).to.equal(false);
  });

  it('accepts a smaller network once the larger counts have left the window', async () => {
    node.serve(1929);
    await hasManyApps('127.0.0.1', node.port, base);
    node.serve(1000);
    expect(await hasManyApps('127.0.0.1', node.port, base + windowMs - 1)).to.equal(false);
    expect(await hasManyApps('127.0.0.1', node.port, base + windowMs)).to.equal(true);
  });
});

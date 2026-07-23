// Active-standby picks the ONE instance that serves; the rest are warm standbys sharing
// state through syncthing, and two serving at once is the corruption the mode exists to
// prevent. The unit of selection is an instance - a node, and the named replica on it -
// not a node alone, because a node can host several co-located replicas of the same app.
//
// A loose (unnamed) instance IS its node; tests/gAppPrimarySelectionTest.js covers those.
// These cover co-located replicas, driven through the same pass against stand-in nodes.
const chai = require('chai');
const http = require('http');
const { selectActiveStandbyPrimaries } = require('../../src/services/domainService');

const { expect } = chai;

// Module-level sticky state is keyed by app name, so every test uses its own app.
let appCounter = 0;
const freshApp = () => {
  appCounter += 1;
  const name = `standbyapp${appCounter}`;
  return { version: 8, name, compose: [{ name: 'app', containerData: 'g:/data' }] };
};

// The container a replica of the app's g: component runs as; a loose instance has none.
const containerOf = (app, replica = null) => `/fluxapp_${app.name}${replica ? `_${replica}` : ''}`;

// One stand-in FluxOS node answering /apps/listrunningapps from a mutable list, counting
// the requests it serves.
function serveNode() {
  const state = { running: [], requests: 0 };
  const server = http.createServer((req, res) => {
    state.requests += 1;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const data = req.url.startsWith('/apps/heldcomponents') ? [] : state.running.map((name) => ({ Names: [name] }));
    res.end(JSON.stringify({ status: 'success', data }));
  });
  server.state = state;
  return new Promise((resolve) => { server.listen(0, '127.0.0.1', () => resolve(server)); });
}

const addr = (server) => `127.0.0.1:${server.address().port}`;
const location = (server, replica = null) => ({ ip: addr(server), replica });

async function select(app, locations) {
  const chosen = await selectActiveStandbyPrimaries([app], new Map([[app.name, locations]]), { retries: 1, delayMs: 0 });
  return chosen.get(app.name);
}

describe('active-standby instance selection: co-located replicas', () => {
  let node;

  beforeEach(async () => { node = await serveNode(); });
  afterEach(() => new Promise((resolve) => { node.close(resolve); }));

  it('selects ONE replica, not the node', async () => {
    const app = freshApp();
    node.state.running = [containerOf(app, 'blue'), containerOf(app, 'green')];
    expect(await select(app, [location(node, 'blue'), location(node, 'green')])).to.equal(`${addr(node)}#blue`);
  });

  it('picks a healthy replica when its co-located sibling is down', async () => {
    const app = freshApp();
    node.state.running = [containerOf(app, 'green')];
    expect(await select(app, [location(node, 'blue'), location(node, 'green')])).to.equal(`${addr(node)}#green`);
  });

  it('breaks ties on replica name whatever order the locations arrive in, so every director agrees', async () => {
    const first = freshApp();
    const second = freshApp();
    node.state.running = ['alpha', 'omega'].flatMap((r) => [containerOf(first, r), containerOf(second, r)]);
    expect(await select(first, [location(node, 'omega'), location(node, 'alpha')])).to.equal(`${addr(node)}#alpha`);
    expect(await select(second, [location(node, 'alpha'), location(node, 'omega')])).to.equal(`${addr(node)}#alpha`);
  });

  it('sticks to a replica, not to its node', async () => {
    const app = freshApp();
    node.state.running = [containerOf(app, 'green')];
    expect(await select(app, [location(node, 'green')])).to.equal(`${addr(node)}#green`);
    // blue joins the same node and sorts first, but green is the sticky instance.
    node.state.running = [containerOf(app, 'blue'), containerOf(app, 'green')];
    expect(await select(app, [location(node, 'blue'), location(node, 'green')])).to.equal(`${addr(node)}#green`);
  });

  it('fails over to the sibling replica when the sticky one leaves the node', async () => {
    const app = freshApp();
    node.state.running = [containerOf(app, 'green')];
    await select(app, [location(node, 'green')]);
    node.state.running = [containerOf(app, 'blue')];
    expect(await select(app, [location(node, 'blue')])).to.equal(`${addr(node)}#blue`);
  });

  it('a replica and a loose instance on the same node are different instances', async () => {
    const app = freshApp();
    node.state.running = [containerOf(app, 'blue')];
    await select(app, [location(node, 'blue')]);
    node.state.running = [containerOf(app)];
    expect(await select(app, [location(node)])).to.equal(addr(node));
  });

  it('asks a node once for all the replicas it hosts', async () => {
    const app = freshApp();
    node.state.running = [containerOf(app, 'blue'), containerOf(app, 'green')];
    await select(app, [location(node, 'blue'), location(node, 'green')]);
    expect(node.state.requests).to.equal(1);
  });
});

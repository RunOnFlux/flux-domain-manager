/* eslint-disable func-names */
const chai = require('chai');
const http = require('http');

const { expect } = chai;
const checks = require('../src/services/application/checks');

const { getGComponentDockerNames, checkAppRunning, checkAppHeld } = checks;

// zizy: the app component holds the g: volume, mysql has its own local storage.
// Only the elected master runs fluxapp_zizy; every instance runs fluxmysql_zizy.
const zizySpec = {
  version: 8,
  name: 'zizy',
  compose: [
    { name: 'app', containerData: 'g:/appdata' },
    { name: 'mysql', containerData: '/var/lib/mysql' },
  ],
};

const masterContainers = [
  { Names: ['/fluxmysql_zizy'] },
  { Names: ['/fluxapp_zizy'] },
];
const standbyContainers = [{ Names: ['/fluxmysql_zizy'] }];

// /apps/heldcomponents answers with the identifiers WITHOUT docker's leading
// slash, which is the join this check has to get right.
function serveHeldComponents(held, { status = 200 } = {}) {
  const server = http.createServer((req, res) => {
    if (status !== 200) {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'error', data: { message: 'Not Found' } }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'success', data: held }));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function serveRunningApps(containers) {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'success', data: containers }));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

describe('g: app master health check', () => {
  describe('getGComponentDockerNames', () => {
    it('returns only the g: component, not every component of the app', () => {
      expect(getGComponentDockerNames(zizySpec)).to.deep.equal(['/fluxapp_zizy']);
    });

    it('returns the bare app container for a v1-3 g: app', () => {
      const spec = { version: 3, name: 'legacyapp', containerData: 'g:/data' };
      expect(getGComponentDockerNames(spec)).to.deep.equal(['/fluxlegacyapp']);
    });

    it('returns nothing for a v1-3 app without g: storage', () => {
      const spec = { version: 3, name: 'legacyapp', containerData: '/data' };
      expect(getGComponentDockerNames(spec)).to.deep.equal([]);
    });

    it('does not prefix a component that is already flux-namespaced', () => {
      const spec = {
        version: 8,
        name: 'bar',
        compose: [{ name: 'fluxy', containerData: 'g:/data' }],
      };
      expect(getGComponentDockerNames(spec)).to.deep.equal(['/fluxy_bar']);
    });

    it('returns every g: component when an app has more than one', () => {
      const spec = {
        version: 8,
        name: 'multi',
        compose: [
          { name: 'one', containerData: 'g:/a' },
          { name: 'two', containerData: 'g:/b' },
          { name: 'three', containerData: '/local' },
        ],
      };
      expect(getGComponentDockerNames(spec)).to.deep.equal(['/fluxone_multi', '/fluxtwo_multi']);
    });
  });

  describe('checkAppHeld', () => {
    let server;

    afterEach(() => {
      if (server) server.close();
      server = null;
    });

    // An owner who stopped their master to work on its files still owns the
    // writable copy of the volume. Health-checking it away and re-selecting is
    // how a stop/start cycle moves the primary onto a different node's data.
    it('recognises a master that is deliberately holding the g: component', async () => {
      server = await serveHeldComponents(['fluxapp_zizy', 'fluxmysql_zizy']);
      const result = await checkAppHeld(`127.0.0.1:${server.address().port}`, zizySpec);
      expect(result).to.equal(true);
    });

    it('does not treat a node holding only the non-g: component as the master', async () => {
      server = await serveHeldComponents(['fluxmysql_zizy']);
      const result = await checkAppHeld(`127.0.0.1:${server.address().port}`, zizySpec);
      expect(result).to.equal(false);
    });

    it('does not match a different app that shares a name prefix', async () => {
      server = await serveHeldComponents(['fluxapp_zizy2']);
      const result = await checkAppHeld(`127.0.0.1:${server.address().port}`, zizySpec);
      expect(result).to.equal(false);
    });

    it('reports nothing held when the list is empty', async () => {
      server = await serveHeldComponents([]);
      const result = await checkAppHeld(`127.0.0.1:${server.address().port}`, zizySpec);
      expect(result).to.equal(false);
    });

    // THE SAFETY PROPERTY. /apps/heldcomponents does not exist on the released
    // FluxOS line, so most of the fleet answers 404 until it upgrades. That must
    // read as "cannot say" and leave the existing selection untouched - never as
    // "held", which would pin traffic to a node on no evidence at all.
    it('says nothing is held when the node is too old for the endpoint', async () => {
      server = await serveHeldComponents(null, { status: 404 });
      const result = await checkAppHeld(`127.0.0.1:${server.address().port}`, zizySpec);
      expect(result).to.equal(false);
    });

    it('says nothing is held when the node cannot be reached', async () => {
      // port 1 is reserved and nothing listens on it
      const result = await checkAppHeld('127.0.0.1:1', zizySpec);
      expect(result).to.equal(false);
    });

    it('says nothing is held for an app with no g: component at all', async () => {
      server = await serveHeldComponents(['fluxapp_plain']);
      const spec = { version: 3, name: 'plain', containerData: '/data' };
      const result = await checkAppHeld(`127.0.0.1:${server.address().port}`, spec);
      expect(result).to.equal(false);
    });
  });

  describe('checkAppRunning', () => {
    let server;

    afterEach(() => {
      if (server) server.close();
      server = null;
    });

    it('reports the master running the g: component as healthy', async () => {
      server = await serveRunningApps(masterContainers);
      const result = await checkAppRunning(`127.0.0.1:${server.address().port}`, zizySpec);
      expect(result).to.equal(true);
    });

    // Regression: the previous substring match on container names saw fluxmysql_zizy,
    // reported the standby as healthy, and pinned traffic to a node serving nothing.
    it('reports a standby running only the non-g: component as unhealthy', async () => {
      server = await serveRunningApps(standbyContainers);
      const result = await checkAppRunning(`127.0.0.1:${server.address().port}`, zizySpec);
      expect(result).to.equal(false);
    });

    // pokerflux/sftpnginx shape: the master runs one g: component and not another.
    // It still owns the g: data and still serves that component's ports, so
    // withdrawing it from routing would take working ports offline.
    it('still recognises a master whose other g: component has stopped', async () => {
      const spec = {
        version: 7,
        name: 'pokerflux',
        compose: [
          { name: 'pokerth', containerData: 'g:/pokerth' },
          { name: 'nginx', containerData: 'g:/etc/letsencrypt' },
          { name: 'ddns', containerData: 'g:/tmp' },
        ],
      };
      server = await serveRunningApps([{ Names: ['/fluxpokerth_pokerflux'] }]);
      const result = await checkAppRunning(`127.0.0.1:${server.address().port}`, spec);
      expect(result).to.equal(true);
    });

    it('does not match a different app that shares a name prefix', async () => {
      server = await serveRunningApps([{ Names: ['/fluxapp_zizy2'] }]);
      const result = await checkAppRunning(`127.0.0.1:${server.address().port}`, zizySpec);
      expect(result).to.equal(false);
    });

    it('refuses an app with no g: component rather than passing every node', async () => {
      server = await serveRunningApps(masterContainers);
      const spec = {
        version: 8,
        name: 'zizy',
        compose: [{ name: 'app', containerData: '/appdata' }],
      };
      const result = await checkAppRunning(`127.0.0.1:${server.address().port}`, spec);
      expect(result).to.equal(false);
    });

    it('reports unhealthy when the node cannot be reached', async () => {
      const result = await checkAppRunning('127.0.0.1:1', zizySpec);
      expect(result).to.equal(false);
    });
  });
});

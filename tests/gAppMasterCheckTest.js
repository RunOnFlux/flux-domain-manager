/* eslint-disable func-names */
const chai = require('chai');
const http = require('http');

const { expect } = chai;
const checks = require('../src/services/application/checks');

const { getGComponentDockerNames, checkAppRunning } = checks;

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

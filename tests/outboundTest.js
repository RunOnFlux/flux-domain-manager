/* eslint-disable func-names */
const chai = require('chai');
const http = require('http');
const axios = require('axios');
const { SOCKET_POLICY, MONGO_SOCKET_OPTIONS, createHttpClient } = require('../src/lib/outbound');
const httpClients = require('../src/services/httpClients');

const { expect } = chai;

function listen(handler, host = '127.0.0.1') {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, host, () => resolve(server));
  });
}

// The kernel behaviour the policy exists for (a bound, SO_REUSEADDR socket does
// not block a listener's bind) is Linux-specific and is not exercised here.
describe('outbound connection policy', () => {
  it('binds through 0.0.0.0 and resolves IPv4 only', () => {
    expect(SOCKET_POLICY).to.deep.equal({ localAddress: '0.0.0.0', family: 4 });
    expect(MONGO_SOCKET_OPTIONS).to.deep.equal(SOCKET_POLICY);
  });

  it('gives every shared client keep-alive agents that connect through the policy', () => {
    const reference = createHttpClient().defaults;
    Object.entries(httpClients).forEach(([name, client]) => {
      const { httpAgent, httpsAgent } = client.defaults;
      expect(httpAgent, name).to.be.instanceOf(reference.httpAgent.constructor);
      expect(httpsAgent, name).to.be.instanceOf(reference.httpsAgent.constructor);
      [httpAgent, httpsAgent].forEach((agent) => {
        expect(agent.options.keepAlive, name).to.equal(true);
      });
    });
  });

  it('keeps TLS options on the agent', () => {
    const client = createHttpClient({ tls: { rejectUnauthorized: false } });
    expect(client.defaults.httpsAgent.options).to.include({ rejectUnauthorized: false });
    expect(httpClients.nodeChecksSelfSigned.defaults.httpsAgent.options.rejectUnauthorized).to.equal(false);
    expect(httpClients.nodeChecks.defaults.httpsAgent.options.rejectUnauthorized).to.equal(undefined);
  });

  it('makes requests through a bound socket', async () => {
    const server = await listen((req, res) => {
      res.end(JSON.stringify({ remote: req.socket.remoteAddress }));
    });
    try {
      const { port } = server.address();
      const response = await createHttpClient().get(`http://127.0.0.1:${port}/`, { timeout: 2_000 });
      expect(response.data.remote).to.match(/127\.0\.0\.1$/);
    } finally {
      server.close();
    }
  });

  it('binds IPv4 connections and leaves IPv6 connections unbound', async () => {
    const seen = [];
    const original = http.Agent.prototype.createConnection;
    http.Agent.prototype.createConnection = function (options, callback) {
      seen.push({ host: options.host, localAddress: options.localAddress, family: options.family });
      return original.call(this, options, callback);
    };
    const servers = await Promise.all([listen((req, res) => res.end('{}')), listen((req, res) => res.end('{}'), '::1')]);
    try {
      const client = createHttpClient();
      await client.get(`http://127.0.0.1:${servers[0].address().port}/`, { timeout: 2_000 });
      await client.get(`http://[::1]:${servers[1].address().port}/`, { timeout: 2_000 });
    } finally {
      http.Agent.prototype.createConnection = original;
      servers.forEach((server) => server.close());
    }
    expect(seen).to.deep.equal([
      { host: '127.0.0.1', ...SOCKET_POLICY },
      { host: '::1', localAddress: undefined, family: undefined },
    ]);
  });

  it('reaches an IPv6 address', async () => {
    const server = await listen((req, res) => {
      res.end(JSON.stringify({ remote: req.socket.remoteAddress }));
    }, '::1');
    try {
      const { port } = server.address();
      const response = await createHttpClient().get(`http://[::1]:${port}/`, { timeout: 2_000 });
      expect(response.data.remote).to.equal('::1');
    } finally {
      server.close();
    }
  });

  it('ends a request whose response keeps trickling', async () => {
    const server = await listen((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.write('[');
      const trickle = setInterval(() => res.write('1,'), 50);
      res.on('close', () => clearInterval(trickle));
    });
    try {
      const { port } = server.address();
      const started = Date.now();
      const error = await createHttpClient()
        .get(`http://127.0.0.1:${port}/`, { timeout: 150 })
        .then(() => null, (e) => e);
      expect(axios.isCancel(error)).to.equal(true);
      expect(Date.now() - started).to.be.within(300, 1_000);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });
});

/* eslint-disable func-names */
const chai = require('chai');
const http = require('http');
const { SOCKET_POLICY, MONGO_SOCKET_OPTIONS, createHttpClient } = require('../src/lib/outbound');
const httpClients = require('../src/services/httpClients');

const { expect } = chai;

function listen(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

// The kernel behaviour the policy exists for (a bound, SO_REUSEADDR socket does
// not block a listener's bind) is Linux-specific and is not exercised here.
describe('outbound connection policy', () => {
  it('binds through 0.0.0.0 and resolves IPv4 only', () => {
    expect(SOCKET_POLICY).to.deep.equal({ localAddress: '0.0.0.0', family: 4 });
    expect(MONGO_SOCKET_OPTIONS).to.deep.equal(SOCKET_POLICY);
  });

  it('gives every shared client agents that carry the policy', () => {
    Object.entries(httpClients).forEach(([name, client]) => {
      const { httpAgent, httpsAgent } = client.defaults;
      [httpAgent, httpsAgent].forEach((agent) => {
        expect(agent.options, name).to.include(SOCKET_POLICY);
        expect(agent.options.keepAlive, name).to.equal(true);
      });
    });
  });

  it('keeps TLS options and the policy together on one agent', () => {
    const client = createHttpClient({ tls: { rejectUnauthorized: false } });
    expect(client.defaults.httpsAgent.options).to.include({ rejectUnauthorized: false, ...SOCKET_POLICY });
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

  it('ends a request whose response stalls after the headers', async () => {
    const server = await listen((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.write('{"partial":');
    });
    try {
      const { port } = server.address();
      const started = Date.now();
      const error = await createHttpClient()
        .get(`http://127.0.0.1:${port}/`, { timeout: 150 })
        .then(() => null, (e) => e);
      expect(error).to.be.an('error');
      expect(Date.now() - started).to.be.below(2_000);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });
});

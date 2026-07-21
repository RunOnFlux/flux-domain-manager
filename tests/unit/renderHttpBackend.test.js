/* eslint-disable func-names */
// The HTTP LB renderer maps every resolved (haproxy,http) field to haproxy
// directives. Inputs here are plain resolved entries (the shape DeploymentSpec
// produces); the syntax itself is validated against real haproxy by
// tests/local/haproxy-check.js.
const chai = require('chai');
const { renderHttpBackend } = require('../../src/services/haproxy/renderHttpBackend');

const { expect } = chai;

const fullLb = {
  provider: 'haproxy', mode: 'http', customDomains: ['shop.example.com'],
  balancing: 'leastconn', maxConnectionsPerServer: 500,
  timeouts: { server: '45s', connect: '5s', httpRequest: '10s', tunnel: '3600s' },
  retries: { count: 5, retryOn: ['conn-failure', '503'], redispatch: true },
  stickySessions: { cookieName: 'SRVID', maxIdle: '30m', maxLife: '8h' },
  healthCheck: { method: 'GET', expectedStatus: '200-399', interval: '5s', timeout: '3s', rise: 2, fall: 3, path: '/health' },
  managedCertificates: false, scheme: 'httpsRedirect', backendTls: null, drain: null, hostPort: 31000,
};
const servers = [{ name: 'r1', host: '10.0.0.1', port: 31000 }, { name: 'r2', host: '10.0.0.1', port: 31001 }];

describe('renderHttpBackend', function () {
  it('renders every configured LB field into directives', function () {
    const out = renderHttpBackend({ backendName: 'app', servers, lb: fullLb });
    expect(out).to.include('backend app');
    expect(out).to.include('balance leastconn');
    expect(out).to.include('timeout connect 5s');
    expect(out).to.include('timeout server 45s');
    expect(out).to.include('timeout tunnel 3600s');
    expect(out).to.include('retries 5');
    expect(out).to.include('retry-on conn-failure 503');
    expect(out).to.include('option redispatch');
    expect(out).to.include('cookie SRVID insert indirect nocache maxidle 30m maxlife 8h');
    expect(out).to.include('option httpchk GET /health');
    expect(out).to.include('http-check expect status 200-399');
    expect(out).to.include('server r1 10.0.0.1:31000 check inter 5s rise 2 fall 3 maxconn 500 cookie r1');
    expect(out).to.include('server r2 10.0.0.1:31001 check inter 5s rise 2 fall 3 maxconn 500 cookie r2');
  });

  it('keeps the frontend-scoped http-request timeout out of the backend', function () {
    expect(renderHttpBackend({ backendName: 'app', servers, lb: fullLb })).to.not.include('http-request');
  });

  it('omits cookie affinity and httpchk when those toggles are off', function () {
    const lb = { ...fullLb, stickySessions: null, healthCheck: null };
    const out = renderHttpBackend({ backendName: 'app', servers, lb });
    expect(out).to.not.include('cookie');
    expect(out).to.not.include('httpchk');
    expect(out).to.include('server r1 10.0.0.1:31000 check maxconn 500');
  });

  it('adds backend TLS to server lines when backendTls is on', function () {
    const lb = { ...fullLb, backendTls: {} };
    expect(renderHttpBackend({ backendName: 'app', servers, lb })).to.include('ssl verify none');
  });

  it('honors the balancing algorithm and retry redispatch toggle', function () {
    const lb = { ...fullLb, balancing: 'roundrobin', retries: { count: 0, retryOn: [], redispatch: false } };
    const out = renderHttpBackend({ backendName: 'app', servers, lb });
    expect(out).to.include('balance roundrobin');
    expect(out).to.include('retries 0');
    expect(out).to.not.include('retry-on');
    expect(out).to.not.include('option redispatch');
  });
});

'use strict';

// A v9 route that declares the haproxy tcp variant is pure passthrough on its own port:
// haproxy proxies bytes, never parses them. It is rendered through the real pipeline
// (flux-spec resolves the route, buildRouteConfigs carries it, createAppsHaproxyConfig
// writes the whole file), because the defect this pins lived between the stages: each
// stage was right about its own input and the route still reached the renderer as http.
const chai = require('chai');
const { load } = require('@runonflux/flux-spec-cjs');
const { renderConfig, routeConfigsForSpec } = require('./fixtures/renderPipeline');
const { createAppsHaproxyConfig } = require('../../src/services/haproxyTemplate');

const { expect } = chai;

const PORT = 31500;

const tcpSubmission = (lb = {}) => ({
  version: 9,
  name: 'game',
  description: 'x',
  owner: '16dNCFf7nR3nx5iwn2RQMBw6KcJXkE3JC1',
  ttl: 2592000,
  instances: 1,
  contacts: { email: ['a@b.com'] },
  components: {
    server: {
      name: 'server',
      description: 'x',
      image: 'nginx:latest',
      cpu: 0.5,
      memory: 300,
      rootFsGb: 2,
      ports: { game: { containerPort: 7777, hostPort: PORT } },
      loadBalancing: { game: { provider: 'haproxy', mode: 'tcp', ...lb } },
    },
  },
});

async function tcpWire(lb) {
  const { FluxAppSpecV9 } = await load();
  return FluxAppSpecV9.fromSubmission(tcpSubmission(lb)).serialize();
}

/** The named section's lines, from its header to the next section. */
function section(config, header) {
  const lines = config.split('\n');
  const start = lines.findIndex((l) => l === header);
  if (start === -1) return null;
  const end = lines.findIndex((l, i) => i > start && /^\S/.test(l));
  return lines.slice(start, end === -1 ? undefined : end);
}

describe('a v9 tcp route', () => {
  it('renders nothing undefined anywhere in the file, with every tcp toggle on', async () => {
    const config = await renderConfig([await tcpWire({
      stickySessions: {},
      healthCheck: { probe: { send: 'PING\r\n', expect: '+PONG' } },
    })]);
    expect(config).to.not.match(/\bundefined\b/);
    expect(config).to.not.match(/\bnull\b/);
  });

  it('is served by its own tcp frontend on its port, straight to its backend', async () => {
    const config = await renderConfig([await tcpWire()]);
    const frontend = section(config, `frontend tcp_route_${PORT}`);
    expect(frontend, config).to.not.equal(null);
    expect(frontend).to.include(`  bind 0.0.0.0:${PORT}`);
    expect(frontend).to.include('  mode tcp');
    expect(frontend.some((l) => /^ {2}default_backend \S+_tcp_backend$/.test(l)), frontend.join('\n')).to.equal(true);
    // Passthrough: nothing waits to inspect the first bytes.
    expect(frontend.join('\n')).to.not.match(/inspect-delay|req_ssl_hello_type|req\.ssl_sni/);
  });

  it('has no http backend and no http routing', async () => {
    const config = await renderConfig([await tcpWire()]);
    expect(config).to.not.match(/hdr\(host\) game_31500\./);
    const httpBackends = config.split('\n').filter((l) => /^backend game_31500\S*backend$/.test(l) && !/_tcp_backend$/.test(l));
    expect(httpBackends).to.deep.equal([]);
  });

  it('renders the tcp variant\'s own settings on a tcp backend', async () => {
    const config = await renderConfig([await tcpWire({
      balancing: 'leastconn',
      maxConnectionsPerServer: 300,
      stickySessions: { expire: '45m', tableSize: 5000 },
      timeouts: { server: '120s' },
      healthCheck: { interval: '7s', rise: 3, fall: 4 },
    })]);
    const backendHeader = config.split('\n').find((l) => /^backend game_31500\S*_tcp_backend$/.test(l));
    const backend = section(config, backendHeader).join('\n');
    expect(backend).to.include('\n  mode tcp');
    expect(backend).to.include('\n  balance leastconn');
    expect(backend).to.include('\n  stick-table type ip size 5000 expire 45m');
    expect(backend).to.include('\n  stick on src');
    expect(backend).to.include('\n  option tcp-check');
    expect(backend).to.include('\n  timeout connect 5s');
    expect(backend).to.include('\n  timeout server 120s');
    expect(backend).to.include('\n  timeout tunnel 3600s');
    expect(backend).to.include('\n  retries 3');
    expect(backend).to.include('\n  option redispatch');
    expect(backend).to.match(/\n {2}server \S+ \S+:31500 check inter 7s rise 3 fall 4 maxconn 300/);
    // None of the http variant's directives.
    expect(backend).to.not.match(/cookie|httpchk|http-check|http-request|retry-on|ssl/);
  });

  it('sends and expects the probe as the owner\'s exact bytes, in hex', async () => {
    const config = await renderConfig([await tcpWire({
      healthCheck: { probe: { send: 'PING\r\n', expect: '+PONG' } },
    })]);
    expect(config).to.include(`\n  tcp-check send-binary ${Buffer.from('PING\r\n').toString('hex')}`);
    expect(config).to.include(`\n  tcp-check expect binary ${Buffer.from('+PONG').toString('hex')}`);
  });

  it('checks the connection alone when no probe is declared', async () => {
    const config = await renderConfig([await tcpWire({ healthCheck: {} })]);
    expect(config).to.include('\n  option tcp-check');
    expect(config).to.not.match(/tcp-check (send|expect)/);
  });

  it('carries no health check and no affinity when those toggles are off', async () => {
    const config = await renderConfig([await tcpWire()]);
    expect(config).to.not.match(/tcp-check|stick-table|stick on/);
  });

  it('leaves an http route beside it exactly as it renders alone', async () => {
    const { FluxAppSpecV9 } = await load();
    const http = FluxAppSpecV9.fromSubmission({
      ...tcpSubmission(),
      name: 'shop',
      components: {
        web: {
          name: 'web',
          description: 'x',
          image: 'nginx:latest',
          cpu: 0.5,
          memory: 300,
          rootFsGb: 2,
          ports: { http: { containerPort: 80, hostPort: 31000 } },
          loadBalancing: { http: { provider: 'haproxy', mode: 'http' } },
        },
      },
    }).serialize();
    const alone = await renderConfig([http]);
    const together = await renderConfig([http, await tcpWire()]);
    const shopLines = (cfg) => cfg.split('\n').filter((l) => /shop/.test(l));
    expect(shopLines(together)).to.deep.equal(shopLines(alone));
  });
});

// One route the renderer cannot write whole must not cost the director its routing:
// haproxy refuses a file with one bad line, and the previous file then stays in force
// for every app.
describe('a route that renders an unset value', () => {
  async function httpRoutes(name, hostPort) {
    const { FluxAppSpecV9 } = await load();
    return routeConfigsForSpec(FluxAppSpecV9.fromSubmission({
      ...tcpSubmission(),
      name,
      components: {
        web: {
          name: 'web',
          description: 'x',
          image: 'nginx:latest',
          cpu: 0.5,
          memory: 300,
          rootFsGb: 2,
          ports: { http: { containerPort: 80, hostPort } },
          loadBalancing: { http: { provider: 'haproxy', mode: 'http' } },
        },
      },
    }).serialize());
  }

  it('is dropped, and every other route is still written', async () => {
    const good = await httpRoutes('shop', 31000);
    // The port route carries the v9 tuning the renderer reads; emptying its timeouts
    // leaves them unset.
    const broken = (await httpRoutes('wreck', 31100))
      .map((route) => (route.domain.startsWith('wreck_31100.') ? { ...route, timeouts: {} } : route));
    const config = createAppsHaproxyConfig([...broken, ...good]);
    expect(config).to.not.match(/\bundefined\b/);
    expect(config, 'the broken route').to.not.match(/wreck_31100/);
    expect(config, 'the same app\'s other route').to.match(/^backend wreckapp2runonfluxiobackend$/m);
    const shopLines = (cfg) => cfg.split('\n').filter((l) => /shop/.test(l));
    expect(shopLines(config), 'another app, as it renders alone')
      .to.deep.equal(shopLines(createAppsHaproxyConfig(good)));
  });
});

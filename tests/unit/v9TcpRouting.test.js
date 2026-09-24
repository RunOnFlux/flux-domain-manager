'use strict';

// The haproxy tcp variant is not offered: a raw tcp route needs a port reserved for it
// on the balancer fleet, and FDM does not allocate one. A v9 route that declares it is
// run through the real pipeline (flux-spec resolves it, buildRouteConfigs carries it,
// createAppsHaproxyConfig writes the whole file) and must come out unrouted, taking
// nothing with it.
const chai = require('chai');
const { load } = require('@runonflux/flux-spec-cjs');
const { renderConfig, routeConfigsForSpec } = require('./fixtures/renderPipeline');
const { createAppsHaproxyConfig } = require('../../src/services/haproxyTemplate');
const log = require('../../src/lib/log');

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

const httpWire = async (name, hostPort) => {
  const { FluxAppSpecV9 } = await load();
  return FluxAppSpecV9.fromSubmission({
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
  }).serialize();
};

describe('a v9 route declaring tcp', () => {
  const originalError = log.error;
  let errors;
  beforeEach(() => {
    errors = [];
    log.error = (m) => errors.push(String(m));
  });
  afterEach(() => { log.error = originalError; });

  it('reaches the renderer marked as declared tcp', async () => {
    const routes = await routeConfigsForSpec(await tcpWire());
    const port = routes.find((r) => r.domain.startsWith(`game_${PORT}.`));
    expect(port.declaredTcp).to.equal(true);
  });

  it('is not routed: no frontend, no backend, no binding of its port, and it is logged', async () => {
    const config = await renderConfig([await tcpWire({
      stickySessions: {},
      healthCheck: { probe: { send: 'PING\r\n', expect: '+PONG' } },
    })]);
    expect(config).to.not.match(/game_31500/);
    expect(config).to.not.match(/:31500\b/);
    expect(config).to.not.match(/\bundefined\b/);
    expect(errors.some((m) => /game_31500.*tcp load balancing, which is not offered/.test(m)), errors.join('\n'))
      .to.equal(true);
  });

  it('is never the alias for the app\'s main domain', async () => {
    const config = await renderConfig([await tcpWire()]);
    expect(config).to.not.match(/game\.app2/);
  });

  it('leaves every other app exactly as it renders alone', async () => {
    const http = await httpWire('shop', 31000);
    expect(await renderConfig([http, await tcpWire()])).to.equal(await renderConfig([http]));
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

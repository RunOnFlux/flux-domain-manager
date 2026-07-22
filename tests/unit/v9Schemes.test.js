// v9 has no apps in the wild yet, so these synthetic specs are the regression net for
// the HTTP load-balancer surface: each scheme (httpsRedirect / httpsOnly / httpOnly /
// httpPassthrough), the managed-certificate gate, and a kitchen-sink app exercising all
// of it at once. Each spec flows the full pipeline (fromSubmission -> deserialize ->
// resolveDeployment -> buildRouteConfigs -> createAppsHaproxyConfig), and we assert both
// the rendered haproxy directives and the cert-path domain derivation. The local harness
// tests/local/live-render-check-v9.js proves real haproxy 2.9 accepts the output.
const chai = require('chai');
const specLibs = require('../../src/services/flux/specLibs');
const { buildRouteConfigs } = require('../../src/services/haproxy/buildRouteConfigs');
const { createAppsHaproxyConfig } = require('../../src/services/haproxyTemplate');
const { getUnifiedDomains, getCustomDomains } = require('../../src/services/domain');

const { expect } = chai;

const IPS = ['10.0.0.1:16127', '10.0.0.2:16127'];

const component = (name, hostPort, lb) => ({
  name,
  description: name,
  image: 'nginx:latest',
  cpu: 0.5,
  memory: 300,
  rootFsGb: 2,
  persistentStorage: { sizeGb: 5 },
  ports: { web: { containerPort: 80, hostPort } },
  loadBalancing: { web: { provider: 'haproxy', mode: 'http', ...lb } },
});

const spec = (components) => ({
  version: 9,
  name: 'app',
  description: 'x',
  owner: '16dNCFf7nR3nx5iwn2RQMBw6KcJXkE3JC1',
  ttl: 2592000,
  contacts: { email: ['a@b.com'] },
  instances: 3,
  components,
});

// Full pipeline: returns the rendered config + the resolved deployment (for cert-path
// assertions). Reads back through serialize/deserialize the way production does.
const render = async (components) => {
  const { FluxAppSpecV9 } = await specLibs.load();
  const wire = FluxAppSpecV9.fromSubmission(spec(components)).serialize();
  const deployment = await specLibs.resolveDeployment(await specLibs.deserialize(wire), null);
  const routeConfigs = buildRouteConfigs(deployment, 'app', IPS, false, false);
  return { config: createAppsHaproxyConfig(routeConfigs), deployment };
};

describe('v9 schemes — edge exposure + cert gating', () => {
  it('httpsRedirect (default): custom domain terminates, blanket :80 redirect, cert obtained', async () => {
    const { config, deployment } = await render({ web: component('web', 31000, { customDomains: ['shop.com'], managedCertificates: true }) });
    // custom domain routes on the terminating side; no deny/serve/router present
    expect(config).to.include('hdr(host) shop.com');
    expect(config).to.include('redirect scheme https if !letsencrypt-acl !cloudflare-flux-acl\n');
    expect(config).to.not.include('http-request deny if httpsonly-hosts');
    expect(config).to.not.include('https-sni-router');
    // platform FQDN + custom domain both cert-eligible
    expect(getUnifiedDomains(deployment)).to.include('app_31000.app2.runonflux.io');
    expect(getCustomDomains(deployment)).to.include('shop.com');
  });

  it('httpsOnly: terminates on :443 but denies plain http on :80', async () => {
    const { config, deployment } = await render({ web: component('web', 31000, { scheme: 'httpsOnly', customDomains: ['only.com'], managedCertificates: true }) });
    expect(config).to.include('acl httpsonly-hosts hdr(host) only.com www.only.com test.only.com');
    expect(config).to.include('http-request deny if httpsonly-hosts');
    // still terminates (routed on the https side) and still cert-eligible
    expect(config).to.include('hdr(host) only.com');
    expect(getCustomDomains(deployment)).to.include('only.com');
  });

  it('httpOnly: served on :80, excluded from the redirect, no cert', async () => {
    const { config, deployment } = await render({ web: component('web', 31000, { scheme: 'httpOnly', customDomains: ['plain.com'] }) });
    expect(config).to.include('use_backend plaincombackend if plaincom');
    expect(config).to.include('redirect scheme https if !letsencrypt-acl !cloudflare-flux-acl !plaincom');
    // not terminated -> not managed -> excluded from the cert path
    expect(getCustomDomains(deployment)).to.not.include('plain.com');
    // platform FQDN still terminates + certs
    expect(getUnifiedDomains(deployment)).to.include('app_31000.app2.runonflux.io');
  });

  it('httpPassthrough: raw TLS via the :443 SNI router, no cert', async () => {
    const { config, deployment } = await render({ web: component('web', 31000, { scheme: 'httpPassthrough', customDomains: ['thru.com'] }) });
    expect(config).to.include('frontend https-sni-router');
    expect(config).to.include('acl thrucom req.ssl_sni -i thru.com');
    expect(config).to.include('use_backend thrucom_passthrough_backend if thrucom');
    expect(config).to.include('backend thrucom_passthrough_backend\n  mode tcp');
    expect(config).to.include('default_backend https-terminate');
    // the terminating listener is now internal
    expect(config).to.include('bind 127.0.0.1:8443 ssl');
    expect(getCustomDomains(deployment)).to.not.include('thru.com');
  });

  it('managedCertificates:false — terminates but FDM does not obtain the cert (owner points DNS)', async () => {
    const { config, deployment } = await render({ web: component('web', 31000, { scheme: 'httpsRedirect', customDomains: ['byo.com'], managedCertificates: false }) });
    // still routed/terminated
    expect(config).to.include('hdr(host) byo.com');
    // but not in the cert path
    expect(getCustomDomains(deployment)).to.not.include('byo.com');
  });

  it('kitchen sink: one app, four components, four schemes + full tunables renders and validates structurally', async () => {
    const { config } = await render({
      red: component('red', 31000, {
        scheme: 'httpsRedirect',
        customDomains: ['red.com'],
        managedCertificates: true,
        balancing: 'leastconn',
        maxConnectionsPerServer: 500,
        timeouts: { server: '45s', httpRequest: '7s' },
        stickySessions: { cookieName: 'SRVID' },
        healthCheck: { path: '/health' },
        backendTls: { verify: 'none' },
        retries: { count: 5, retryOn: ['conn-failure', '503'] },
      }),
      only: component('only', 31001, { scheme: 'httpsOnly', customDomains: ['only.com'], managedCertificates: true }),
      plain: component('plain', 31002, { scheme: 'httpOnly', customDomains: ['plain.com'] }),
      thru: component('thru', 31003, {
        scheme: 'httpPassthrough', customDomains: ['thru.com'], balancing: 'roundrobin', healthCheck: {},
      }),
    });
    // all four scheme mechanisms present in one config
    expect(config).to.include('http-request deny if httpsonly-hosts'); // httpsOnly
    expect(config).to.include('use_backend plaincombackend if plaincom'); // httpOnly
    expect(config).to.include('frontend https-sni-router'); // httpPassthrough
    expect(config).to.include('balance leastconn'); // full tunables (red)
    expect(config).to.include('cookie SRVID insert indirect nocache maxidle 30m maxlife 8h');
    expect(config).to.include('option httpchk GET /health');
    expect(config).to.include('timeout http-request 7s');
    expect(config).to.include('retry-on conn-failure 503');
  });
});

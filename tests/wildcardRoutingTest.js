/* eslint-disable func-names */
const { expect } = require('chai');
const { spawnSync } = require('child_process');
const { getWildcardAppRoutes, isWildcardAppDomain } = require('../src/services/application/wildcard');
const { createAppsHaproxyConfig } = require('../src/services/haproxyTemplate');

const routes = [{ domain: 'drop.runonflux.io', appName: 'drop', targetDomain: 'drop.app.runonflux.io' }];
const app = (extra = {}) => ({
  name: 'drop',
  appName: 'drop_web_31512',
  domain: 'drop.app.runonflux.io',
  port: 31512,
  ips: ['192.0.2.1:16127', '192.0.2.2:16137'],
  mode: 'http',
  ssl: false,
  check: true,
  headers: false,
  loadBalance: false,
  healthcheck: [],
  serverConfig: '',
  ...extra,
});

describe('operator wildcard app routing', () => {
  it('reuses the discovered HTTP backend before custom domain rules, without changing request headers or paths', () => {
    const generated = createAppsHaproxyConfig([app(), app({ domain: 'drop_31512.app.runonflux.io' })], routes);
    expect((generated.match(/^backend dropapprunonfluxiobackend$/gm) || [])).to.have.lengthOf(1);
    expect(generated).to.include('use_backend dropapprunonfluxiobackend if wildcard_host_0');
    expect(generated.indexOf('use_backend forbidden-backend')).to.be.lessThan(generated.indexOf('if wildcard_host_0'));
    expect(generated.indexOf('if wildcard_host_0')).to.be.lessThan(generated.indexOf('if dropapprunonfluxio'));
    expect(generated).to.include('192.0.2.1:31512 check');
    expect(generated).to.include('192.0.2.2:31512 check');
    const targetBackend = generated.split('backend dropapprunonfluxiobackend\n')[1].split('\nbackend ')[0];
    expect(targetBackend).to.not.match(/http-request (set-header Host|set-path|replace-path|set-uri)/);
    expect(generated).to.not.include('ssl verify none');
  });

  it('matches exactly one valid DNS label, normalizing case, port and a trailing dot', () => {
    const generated = createAppsHaproxyConfig([app()], routes);
    const expression = generated.match(/acl wildcard_host_0 .* -m reg (.*)/)[1];
    const regex = new RegExp(expression);
    ['hello.drop.runonflux.io', 'a.drop.runonflux.io', `${'a'.repeat(63)}.drop.runonflux.io`, 'HELLO.DROP.RUNONFLUX.IO:443', 'hello.drop.runonflux.io.'].forEach((host) => {
      expect(regex.test(host.toLowerCase().split(':')[0]), host).to.equal(true);
    });
    ['drop.runonflux.io', 'a.b.drop.runonflux.io', '-bad.drop.runonflux.io', 'bad-.drop.runonflux.io', '_bad.drop.runonflux.io', `${'a'.repeat(64)}.drop.runonflux.io`, 'hello.drop.runonflux.io.evil.com', 'helloXdropYrunonfluxZio'].forEach((host) => {
      expect(regex.test(host), host).to.equal(false);
    });
  });

  it('reserves the namespace even when the target is absent and regardless of app ordering', () => {
    const attacker = app({
      name: 'other', appName: 'other_web_30000', domain: 'hello.drop.runonflux.io', port: 30000,
    });
    [[], [attacker], [attacker, app()], [app(), attacker]].forEach((apps) => {
      const generated = createAppsHaproxyConfig(apps, routes);
      expect(generated).to.not.include('backend hellodroprunonfluxiobackend');
      expect(generated).to.include('use_backend wildcard_not_found if wildcard_namespace_0');
      if (!apps.some((entry) => entry.name === 'drop')) {
        expect(generated).to.include('use_backend wildcard_unavailable if wildcard_host_0');
        expect(generated).to.include('http-request return status 503');
      }
    });
  });

  it('does not accept another app claiming the configured target domain', () => {
    const generated = createAppsHaproxyConfig([app({ name: 'impostor', appName: 'impostor_31512' })], routes);
    expect(generated).to.include('use_backend wildcard_unavailable if wildcard_host_0');
  });

  it('fails closed for an empty instance list and follows changed ports and instances', () => {
    expect(createAppsHaproxyConfig([app({ ips: [] })], routes)).to.include('use_backend wildcard_unavailable if wildcard_host_0');
    const generated = createAppsHaproxyConfig([app({ port: 39999, ips: ['192.0.2.9:16127'] })], routes);
    expect(generated).to.include('192.0.2.9:39999 check');
    expect(generated).to.not.include('192.0.2.1:31512');
  });

  it('rejects ambiguous, TLS and TCP targets', () => {
    expect(() => createAppsHaproxyConfig([app(), app()], routes)).to.throw('Ambiguous wildcard target');
    expect(() => createAppsHaproxyConfig([app({ ssl: true })], routes)).to.throw('must use HTTP');
    expect(() => createAppsHaproxyConfig([app({ mode: 'tcp' })], routes)).to.throw('must use HTTP');
  });

  it('leaves existing output unchanged when no bindings are configured', () => {
    const generated = createAppsHaproxyConfig([app()], []);
    expect(generated).to.not.include('wildcard_');
    expect(generated).to.include('use_backend dropapprunonfluxiobackend if dropapprunonfluxio');
  });

  it('uses the published app port and explicit TLS setting on IPv6 backends', () => {
    const ips = ['[2001:db8::1]:16127'];
    const generated = createAppsHaproxyConfig([app({ ips })], routes);
    expect(generated).to.include('[2001:db8::1]:31512 check');
    expect(generated).to.not.include('ssl verify none');
    expect(createAppsHaproxyConfig([app({ ips, ssl: true })], [])).to.include('ssl verify none');
  });
});

describe('wildcard binding configuration and domain reservation', () => {
  it('normalizes configuration, supports generated per-port targets, and reserves complete namespaces', () => {
    expect(getWildcardAppRoutes([{ domain: 'DROP.RUNONFLUX.IO', appName: 'Drop', targetDomain: 'drop_31512.app.runonflux.io' }])[0])
      .to.deep.equal({ domain: 'drop.runonflux.io', appName: 'drop', targetDomain: 'drop_31512.app.runonflux.io' });
    ['drop.runonflux.io', 'HELLO.DROP.RUNONFLUX.IO.', 'nested.hello.drop.runonflux.io'].forEach((domain) => {
      expect(isWildcardAppDomain(domain, routes)).to.equal(true);
    });
    expect(isWildcardAppDomain('drop.runonflux.io.evil.com', routes)).to.equal(false);
  });

  it('rejects malformed, overlapping, recursive and injectable configuration', () => {
    const invalid = [null, {}, ['bad'], [{}], [{ ...routes[0], domain: '*.drop.runonflux.io' }],
      [{ ...routes[0], domain: 'drop.runonflux.io\nbackend injected' }], [{ ...routes[0], targetDomain: 'https://drop.app.runonflux.io/' }],
      [{ ...routes[0], appName: 'drop\nbackend injected' }], [routes[0], routes[0]],
      [routes[0], { ...routes[0], domain: 'nested.drop.runonflux.io' }], [{ ...routes[0], targetDomain: 'hello.drop.runonflux.io' }]];
    invalid.forEach((input) => expect(() => getWildcardAppRoutes(input)).to.throw());
  });

  it('does not provision DNS or certificates for reserved custom domain claims (legacy and composed specs)', () => {
    // Load the normal config in a child so the other tests keep their defaults.
    const code = `const {getCustomDomains}=require('./src/services/domain');
      const domains=['hello.drop.runonflux.io,drop.runonflux.io,example.com'];
      console.log(JSON.stringify([getCustomDomains({version:3,ports:[31512],domains}),getCustomDomains({version:4,compose:[{ports:[31512],domains}]})]));`;
    const child = spawnSync(process.execPath, ['-e', code], {
      cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, NODE_CONFIG: JSON.stringify({ wildcardAppRoutes: routes }) },
    });
    expect(child.status, child.stderr).to.equal(0);
    expect(JSON.parse(child.stdout.trim())).to.deep.equal([
      ['example.com', 'www.example.com', 'test.example.com'], ['example.com', 'www.example.com', 'test.example.com'],
    ]);
  });
});

/* eslint-disable func-names */
const { expect } = require('chai');
const { spawnSync, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { X509Certificate } = require('crypto');
const wildcard = require('../src/services/application/wildcard');

const {
  parseWildcardRoutes, isWildcardAppDomain, certificateFingerprint, getServableWildcardRoutes,
} = wildcard;
const haproxy = require('../src/services/haproxyTemplate');

const { createAppsHaproxyConfig } = haproxy;
const domainService = require('../src/services/domainService');

const routes = [{ domain: 'drop.runonflux.io', targetDomain: 'drop.app2.runonflux.io' }];
const app = (extra = {}) => ({
  name: 'drop',
  appName: 'drop_web_31512',
  domain: 'drop.app2.runonflux.io',
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
  it('appends a suffix rule reusing the exact HTTP backend without changing requests', () => {
    const generated = createAppsHaproxyConfig([app(), app({ domain: 'drop_31512.app2.runonflux.io' })], routes);
    expect((generated.match(/^backend dropapp2runonfluxiobackend$/gm) || [])).to.have.lengthOf(1);
    expect(generated).to.include('acl wildcard_0 req.hdr(host),host_only -m end .drop.runonflux.io');
    expect(generated).to.include('use_backend dropapp2runonfluxiobackend if wildcard_0');
    expect(generated.indexOf('if wildcard_0')).to.be.greaterThan(generated.indexOf('if dropapp2runonfluxio'));
    expect(generated).to.include('192.0.2.1:31512 check');
    expect(generated).to.include('192.0.2.2:31512 check');
    const backend = generated.split('backend dropapp2runonfluxiobackend\n')[1].split('\nbackend ')[0];
    expect(backend).to.not.match(/http-request (set-header Host|set-path|replace-path|set-uri)/);
    expect(generated).to.not.include('ssl verify none');
    expect(generated).to.not.include('wildcard_not_found');
  });

  it('reserves the namespace independent of app ordering and skips absent targets', () => {
    const attacker = app({
      name: 'other', appName: 'other_web_30000', domain: 'hello.drop.runonflux.io', port: 30000,
    });
    [[], [attacker], [attacker, app()], [app(), attacker]].forEach((apps) => {
      const generated = createAppsHaproxyConfig(apps, routes);
      expect(generated).to.not.include('backend hellodroprunonfluxiobackend');
      if (!apps.some((entry) => entry.name === 'drop')) expect(generated).to.not.include('if wildcard_0');
    });
  });

  it('survives duplicate G/non-G snapshots and uses the backend chosen by the HTTP loop', () => {
    const generated = createAppsHaproxyConfig([app(), app({ mode: 'tcp', port: 39999 })], routes);
    expect(generated).to.include('use_backend dropapp2runonfluxiobackend if wildcard_0');
    expect(generated).to.include('192.0.2.1:31512 check');
    const g = createAppsHaproxyConfig([app({ mode: 'tcp' })], routes);
    expect(g).to.include('use_backend dropapp2runonfluxiobackend if wildcard_0');
    expect(g).to.include('frontend tcp_app_31512');
    expect(createAppsHaproxyConfig([app({ ssl: true })], routes)).to.include('if wildcard_0');
  });

  it('skips TCP-only targets without blocking other HTTP apps', () => {
    const generated = createAppsHaproxyConfig([app({ name: 'minecraft' }), app({ name: 'other', appName: 'other', domain: 'other.app2.runonflux.io' })], routes);
    expect(generated).to.not.include('if wildcard_0');
    expect(generated).to.include('backend otherapp2runonfluxiobackend');
  });

  it('tracks aliases, published port changes and empty instance sets without throwing', () => {
    const generated = createAppsHaproxyConfig([app({ domain: 'drop_31512.app2.runonflux.io', port: 39999 }), app()], routes);
    expect(generated).to.include('use_backend drop_31512app2runonfluxiobackend if wildcard_0');
    expect(generated).to.include('192.0.2.1:39999 check');
    expect(() => createAppsHaproxyConfig([app({ ips: [] })], routes)).to.not.throw();
  });

  it('leaves existing output unchanged when no bindings are configured', () => {
    const generated = createAppsHaproxyConfig([app()], []);
    expect(generated).to.not.include('wildcard_');
    expect(generated).to.include('use_backend dropapp2runonfluxiobackend if dropapp2runonfluxio');
  });

  it('uses distinct IPv6 node names, app-port cookies, and explicit TLS/H2 settings', () => {
    const ips = ['[2001:db8::1]:16127', '[2001:db8::1]:16137'];
    const generated = createAppsHaproxyConfig([app({ ips })], routes);
    expect(generated).to.include('server 2001:db8::1:16127 [2001:db8::1]:31512 check');
    expect(generated).to.include('server 2001:db8::1:16137 [2001:db8::1]:31512 check');
    expect(generated).to.include('cookie 2001:db8::1:31512 source [::]:0');
    expect(generated).to.not.include('ssl verify none');
    const tls = createAppsHaproxyConfig([app({ ips, ssl: true })], []);
    expect(tls).to.include('ssl verify none cookie 2001:db8::1:31512');
    const h2 = createAppsHaproxyConfig([app({ ips, ssl: true, enableH2: true })], []);
    expect(h2).to.include('ssl verify none alpn h2,http/1.1 cookie 2001:db8::1:31512');
    expect(createAppsHaproxyConfig([app({ ips, enableH2: true })], [])).to.not.include('ssl verify none');
  });
});

describe('wildcard binding configuration and domain reservation', () => {
  it('normalizes configuration, supports generated per-port targets, and reserves complete namespaces', () => {
    expect(parseWildcardRoutes([{ domain: 'DROP.RUNONFLUX.IO', targetDomain: 'drop_31512.app2.runonflux.io' }])[0])
      .to.deep.equal({ domain: 'drop.runonflux.io', targetDomain: 'drop_31512.app2.runonflux.io' });
    ['drop.runonflux.io', 'HELLO.DROP.RUNONFLUX.IO.', 'nested.hello.drop.runonflux.io'].forEach((domain) => {
      expect(isWildcardAppDomain(domain, routes)).to.equal(true);
    });
    expect(isWildcardAppDomain('drop.runonflux.io.evil.com', routes)).to.equal(false);
  });

  it('rejects malformed, overlapping, non-generated and recursive targets at startup', () => {
    const invalid = [null, {}, ['bad'], [{}], [{ ...routes[0], domain: '*.drop.runonflux.io' }],
      [{ ...routes[0], domain: 'drop.runonflux.io\nbackend injected' }], [{ ...routes[0], targetDomain: 'https://drop.app2.runonflux.io/' }],
      [{ ...routes[0], targetDomain: 'drop.example.com' }], [{ ...routes[0], targetDomain: 'a.b.app2.runonflux.io' }],
      [routes[0], routes[0]], [routes[0], { ...routes[0], domain: 'nested.drop.runonflux.io' }],
      [{ ...routes[0], domain: 'app2.runonflux.io' }]];
    invalid.forEach((input) => expect(() => parseWildcardRoutes(input)).to.throw());
  });

  it('does not provision DNS/certs or HTTP backends for reserved claims, including dormant routes', () => {
    const code = `const {getCustomDomains}=require('./src/services/domain');
      const {createAppsHaproxyConfig}=require('./src/services/haproxyTemplate');
      const domains=['hello.drop.runonflux.io,drop.runonflux.io,example.com,drop.app2.runonflux.io'];
      const generated=createAppsHaproxyConfig([${JSON.stringify(app({ domain: 'hello.drop.runonflux.io' }))}],[]);
      console.log(JSON.stringify([getCustomDomains({version:3,ports:[31512],domains}),getCustomDomains({version:4,compose:[{ports:[31512],domains}]}),generated.includes('backend hellodroprunonfluxiobackend')]));`;
    const child = spawnSync(process.execPath, ['-e', code], {
      cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, NODE_CONFIG: JSON.stringify({ wildcardAppRoutes: routes }) },
    });
    expect(child.status, child.stderr).to.equal(0);
    expect(JSON.parse(child.stdout.trim())).to.deep.equal([
      ['example.com', 'www.example.com', 'test.example.com'], ['example.com', 'www.example.com', 'test.example.com'], false,
    ]);
  });
});

describe('wildcard certificate availability', () => {
  let directory;
  let key;
  let certificate;
  let leaf;
  before(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fdm-wildcard-unit-'));
    const generate = (name, dns) => {
      execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
        '-keyout', path.join(directory, `${name}.key`), '-out', path.join(directory, `${name}.crt`),
        '-subj', `/CN=${dns}`, '-addext', `subjectAltName=DNS:${dns}`], { stdio: 'pipe' });
      return fs.readFileSync(path.join(directory, `${name}.crt`));
    };
    certificate = generate('wildcard', '*.drop.runonflux.io');
    leaf = generate('leaf', 'site.drop.runonflux.io');
    key = fs.readFileSync(path.join(directory, 'wildcard.key'));
  });
  after(() => { fs.rmSync(directory, { recursive: true, force: true }); });

  const check = (now) => certificateFingerprint(routes[0].domain, now, directory);
  const install = (...parts) => fs.writeFileSync(path.join(directory, 'drop.runonflux.io.pem'), Buffer.concat(parts));

  it('requires a readable, parseable PEM with the matching private key and actual wildcard coverage', async () => {
    expect(await check()).to.equal(null);
    install(Buffer.from('not a certificate'));
    expect(await check()).to.equal(null);
    install(certificate);
    expect(await check()).to.equal(null);
    install(certificate, fs.readFileSync(path.join(directory, 'leaf.key')));
    expect(await check()).to.equal(null);
    install(leaf, fs.readFileSync(path.join(directory, 'leaf.key')));
    expect(await check()).to.equal(null);
    install(certificate, key);
    expect(await check()).to.equal(new X509Certificate(certificate).fingerprint256);
  });

  it('rejects expired and not-yet-valid certificates', async () => {
    install(certificate, key);
    const cert = new X509Certificate(certificate);
    expect(await check(Date.parse(cert.validFrom) - 1)).to.equal(null);
    expect(await check(Date.parse(cert.validTo))).to.equal(null);
  });

  it('detects arrival/expiry and includes a fingerprint so certificate renewal changes generated config', async () => {
    const dormant = await getServableWildcardRoutes(routes, async () => null);
    const ready = await getServableWildcardRoutes(routes, async () => 'fingerprint-one');
    const renewed = await getServableWildcardRoutes(routes, async () => 'fingerprint-two');
    expect(dormant).to.deep.equal([]);
    expect(ready).to.deep.equal([{ ...routes[0], certificateFingerprint: 'fingerprint-one' }]);
    expect(createAppsHaproxyConfig([app()], renewed)).to.not.equal(createAppsHaproxyConfig([app()], ready));
    expect(await getServableWildcardRoutes(routes, async () => null)).to.deep.equal([]);
  });

  it('commits route availability only after successful publication, and retries failures', async () => {
    const originalCheck = wildcard.getServableWildcardRoutes;
    const originalPublish = haproxy.restartProxy;
    let current = [];
    let fail = false;
    const configs = [];
    wildcard.getServableWildcardRoutes = async () => current;
    haproxy.restartProxy = async (config) => { configs.push(config); return { ok: !fail, reason: 'test' }; };
    try {
      expect(await domainService.wildcardRoutesChanged()).to.equal(false);
      current = [{ ...routes[0], certificateFingerprint: 'first' }];
      expect(await domainService.wildcardRoutesChanged()).to.equal(true);
      fail = true;
      let failure;
      try { await domainService.updateHaproxy([app()]); } catch (error) { failure = error; }
      expect(failure.message).to.include('Haproxy not updated');
      expect(await domainService.wildcardRoutesChanged()).to.equal(true);
      fail = false;
      await domainService.updateHaproxy([app()]);
      expect(await domainService.wildcardRoutesChanged()).to.equal(false);
      current = [{ ...routes[0], certificateFingerprint: 'renewed' }];
      expect(await domainService.wildcardRoutesChanged()).to.equal(true);
      await domainService.updateHaproxy([app()]);
      expect(configs[2]).to.not.equal(configs[1]);
      current = [];
      expect(await domainService.wildcardRoutesChanged()).to.equal(true);
      await domainService.updateHaproxy([app()]);
      expect(await domainService.wildcardRoutesChanged()).to.equal(false);
    } finally {
      wildcard.getServableWildcardRoutes = originalCheck;
      haproxy.restartProxy = originalPublish;
    }
  });
});

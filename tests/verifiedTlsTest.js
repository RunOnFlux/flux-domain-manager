const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const chai = require('chai');
const config = require('config');
const log = require('../src/lib/log');
const haproxyTemplate = require('../src/services/haproxyTemplate');
const { addConfigurations, createConfiguredApps } = require('../src/services/domainService');
const { fixedCustomDomains } = require('../src/services/domain/customDomain');
const {
  addressOf, isVerifiedTlsApp, resetReports, resolveVerifiedTlsApps,
} = require('../src/services/application/verifiedTls');

const { expect } = chai;

// Documentation-range addresses only (RFC 5737, RFC 3849).
const A = '192.0.2.10';
const B = '198.51.100.20';
const C = '203.0.113.30';
const V6 = '2001:db8::10';
const VERIFY_HOST = 'cloud.origin.runonflux.io';
// The app's two ports: the first mapped to the container's port 80, the second to its TLS port 443.
const HTTP_PORT = 31080;
const TLS_PORT = 31443;
const ZONE = `${config.appSubDomain}.${config.mainDomain}`;

// The shape addConfigurations builds, with application/custom.js defaults: here the entry of the app's TLS port.
const entry = (overrides = {}) => ({
  name: 'cloud',
  appName: `cloud_web_${TLS_PORT}`,
  domain: `cloud_${TLS_PORT}.${ZONE}`,
  port: TLS_PORT,
  ips: [`${A}:16127`, `${B}:16137`, `${C}:16127`],
  isRdata: false,
  ssl: false,
  timeout: false,
  headers: false,
  loadBalance: false,
  healthcheck: [],
  serverConfig: '',
  enableH2: false,
  mode: 'http',
  check: true,
  ...overrides,
});

const other = (name, overrides = {}) => entry({
  name, appName: `${name}_31000`, domain: `${name}.${ZONE}`, port: 31000, ...overrides,
});

// The cloud app's spec as domain/index.js leaves it: one component, its domains FDM's own.
const cloudSpec = () => ({
  name: 'cloud',
  version: 8,
  compose: [{
    name: 'web', ports: [HTTP_PORT, TLS_PORT], domains: [fixedCustomDomains('cloud')], environmentParameters: [],
  }],
});
const cloudDomains = [
  'cloud.runonflux.io', 'www.cloud.runonflux.io', 'test.cloud.runonflux.io',
  'cloud.runonflux.com', 'www.cloud.runonflux.com', 'test.cloud.runonflux.com',
];

// Server lines of app backends; the fixed local backends every config has are left out.
const FIXED_SERVER = /^\s*server (letsencrypt|cloudflareflux|fdm-api) /;
const serverLines = (cfg) => cfg.split('\n')
  .filter((line) => /^\s*server /.test(line) && !FIXED_SERVER.test(line));
const backendBlocks = (cfg) => cfg.split('\nbackend ').slice(1).map((block) => block.split('\n\n')[0]);

// What is logged while fn runs.
function logged(fn) {
  const levels = ['error', 'warn', 'info'];
  const saved = levels.map((level) => log[level]);
  const lines = [];
  levels.forEach((level) => { log[level] = (message) => lines.push(`${level}: ${message}`); });
  try {
    fn();
  } finally {
    levels.forEach((level, i) => { log[level] = saved[i]; });
  }
  return lines;
}

// A seeded pseudo-random generator (Park-Miller), so the corpus is the same on every run.
function seeded(seed) {
  let state = seed;
  return () => {
    state = (state * 16807) % 2147483647;
    return (state - 1) / 2147483646;
  };
}

// 400 entries of every shape the template renders: cloud's own, cloud's domains claimed by other apps, the other
// cloud apps, ssl, h2, tcp, rdata, IPv6, bad ips and timeouts.
function corpus(seed = 1, size = 400) {
  const rand = seeded(seed);
  const pick = (list) => list[Math.floor(rand() * list.length)];
  const names = ['cloud', 'Cloud', 'clouddev', 'cloudy', 'webapp', 'tlsapp', 'dbapp', 'tcpapp', 'wordpressx', 'thief'];
  const ips = [`${A}:16127`, `${B}:16137`, `${C}:16127`, A, `[${V6}]:${TLS_PORT}`, `[2001:db8::20]:${HTTP_PORT}`, 'not-an-ip', ''];
  return Array.from({ length: size }, (_, i) => {
    const name = pick(names);
    const port = pick([HTTP_PORT, TLS_PORT, 31000, 25565, 34443]);
    const lower = name.toLowerCase();
    const domain = pick([
      `${lower}.${ZONE}`, `${lower}_${port}.${ZONE}`, ...cloudDomains, 'dev.cloud.runonflux.io', `site${i % 7}.example.com`,
    ]);
    return entry({
      name,
      appName: `${name}_${pick(['web', 'api'])}_${port}`,
      domain,
      port,
      ips: Array.from({ length: Math.floor(rand() * 4) }, () => pick(ips)),
      isRdata: rand() < 0.2,
      ssl: rand() < 0.2,
      enableH2: rand() < 0.2,
      mode: rand() < 0.15 ? 'tcp' : 'http',
      check: rand() < 0.9,
      loadBalance: rand() < 0.1 ? '\n  balance roundrobin' : false,
      serverConfig: rand() < 0.1 ? 'inter 30s fall 2 rise 2' : '',
      headers: rand() < 0.1 ? ['http-request add-header X-Forwarded-Proto https'] : false,
      healthcheck: rand() < 0.1 ? ['option httpchk', 'http-check send meth GET uri /'] : [],
      timeout: pick([false, false, '30s', 90000, 'bad timeout']),
    });
  });
}

const MAIN = ['home.runonflux.io', 'api.runonflux.io', [`${A}:16127`, `${B}:16137`], 'home.runonflux.com', 'api.runonflux.com',
  'cloud.runonflux.io', 'cloud.runonflux.com'];

describe('verified TLS apps', () => {
  let dir;
  let caFile;
  let tls;
  // CA files haproxy could not load, made next to the test CA.
  const unusable = {};
  const on = (allowedIps, overrides = {}) => ({
    cloud: {
      enabled: true, caFile, verifyHost: VERIFY_HOST, port: TLS_PORT, allowedIps, ...overrides,
    },
  });
  const off = (overrides = {}) => ({ cloud: { ...on([B]).cloud, enabled: false, ...overrides } });

  before(() => {
    // Test data only: a throwaway self-signed CA certificate, made for this run in a temporary directory that is
    // removed after it. Its key is never written anywhere (-keyout /dev/null).
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fdm-verified-tls-'));
    caFile = path.join(dir, 'test-ca.pem');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', '/dev/null', '-out', caFile,
      '-subj', '/CN=FDM verified TLS test CA (test data)', '-days', '1'], { stdio: 'ignore' });
    const pem = fs.readFileSync(caFile, 'latin1');
    const write = (name, content) => {
      const file = path.join(dir, name);
      fs.writeFileSync(file, content);
      return file;
    };
    Object.assign(unusable, {
      empty: write('empty.pem', ''),
      placeholder: write('placeholder.pem', 'test data, not a certificate\n'),
      der: write('test-ca.der', new crypto.X509Certificate(pem).raw),
      broken: write('broken.pem', '-----BEGIN CERTIFICATE-----\ndGVzdCBkYXRh\n-----END CERTIFICATE-----\n'),
      mixed: write('mixed.pem', `${pem}-----BEGIN TEST DATA-----\ndGVzdCBkYXRh\n-----END TEST DATA-----\n`),
      directory: dir,
    });
    tls = `ssl verify required ca-file ${caFile} verifyhost ${VERIFY_HOST} sni str(${VERIFY_HOST}) check-sni ${VERIFY_HOST}`;
  });

  beforeEach(() => {
    resetReports();
  });

  after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  describe('off (the shipped default)', () => {
    it('ships cloud off, with nobody allowed', () => {
      expect(config.verifiedTlsApps.cloud.enabled).to.equal(false);
      expect(config.verifiedTlsApps.cloud.caFile).to.equal('/etc/ssl/flux-internal/ca.pem');
      expect(config.verifiedTlsApps.cloud.verifyHost).to.equal(VERIFY_HOST);
      expect(config.verifiedTlsApps.cloud.allowedIps).to.deep.equal([]);
      expect(resolveVerifiedTlsApps(config.verifiedTlsApps).size).to.equal(0);
    });

    it('renders a corpus with cloud in it byte for byte as with no verified apps', () => {
      const plain = haproxyTemplate.createAppsHaproxyConfig(corpus(), null);
      expect(plain).to.contain(`hdr(host) cloud.${ZONE}\n`).and.contain('hdr(host) cloud.runonflux.io\n');
      expect(plain).to.not.contain('verify required');
      [undefined, config.verifiedTlsApps, off(), off({ enabled: undefined }), off({ caFile: 'nonsense', port: 'x' }),
        { cloud: { allowedIps: [B] } }, { cloud: { enabled: false }, CLOUD: { enabled: false } }]
        .forEach((value) => {
          const lines = logged(() => {
            expect(haproxyTemplate.createAppsHaproxyConfig(corpus(), value), JSON.stringify(value)).to.equal(plain);
          });
          expect(lines.filter((line) => line.includes('verified')), JSON.stringify(value)).to.deep.equal([]);
        });
      [2, 3, 4].forEach((seed) => {
        expect(haproxyTemplate.createAppsHaproxyConfig(corpus(seed)))
          .to.equal(haproxyTemplate.createAppsHaproxyConfig(corpus(seed), null));
      });
    });

    it('leaves the main FDM routing cloud.* as before', () => {
      const plain = haproxyTemplate.createMainHaproxyConfig(...MAIN, null);
      expect(haproxyTemplate.createMainHaproxyConfig(...MAIN)).to.equal(plain);
      expect(haproxyTemplate.createMainHaproxyConfig(...MAIN, off())).to.equal(plain);
      expect(plain).to.contain('  acl homerunonfluxio hdr(host) cloud.runonflux.io\n');
      expect(plain).to.contain('  acl homerunonfluxio hdr(host) cloud.runonflux.com\n');
    });

    it('leaves a domain another app took first with that app, as before', () => {
      const configuredApps = createConfiguredApps();
      configuredApps.push(other('thief', { domain: 'cloud.runonflux.io' }));
      addConfigurations(configuredApps, cloudSpec(), [`${A}:16127`], false, off());
      const owners = configuredApps.list().filter((e) => e.domain === 'cloud.runonflux.io').map((e) => e.name);
      expect(owners).to.deep.equal(['thief']);
      expect(isVerifiedTlsApp(off(), 'cloud')).to.equal(false);
    });
  });

  describe('servers', () => {
    it('routes only to the allowed instances, at the TLS port, over verified TLS', () => {
      const servers = serverLines(haproxyTemplate.createAppsHaproxyConfig([entry()], on([C, B])));
      expect(servers).to.deep.equal([
        `  server allowed1 ${B}:${TLS_PORT} check  ${tls} cookie allowed1 inter 3s fall 2 rise 2 fastinter 500`,
        `  server allowed0 ${C}:${TLS_PORT} check  ${tls} cookie allowed0 inter 3s fall 2 rise 2 fastinter 500`,
      ]);
    });

    it('verifies TLS to an IPv6 instance, at the TLS port', () => {
      const ips = [`[${V6}]:16127`];
      expect(serverLines(haproxyTemplate.createAppsHaproxyConfig([entry({ ips })], on([V6])))).to.deep.equal([
        `  server allowed0 [${V6}]:${TLS_PORT} check  ${tls} cookie allowed0 inter 3s fall 2 rise 2 fastinter 500`,
      ]);
    });

    it('gives an app with an empty allow-list no servers, and keeps its domain', () => {
      const cfg = haproxyTemplate.createAppsHaproxyConfig([entry()], on([]));
      expect(serverLines(cfg)).to.deep.equal([]);
      expect(cfg).to.contain(`  acl cloud_${TLS_PORT}app2runonfluxio hdr(host) cloud_${TLS_PORT}.app2.runonflux.io\n`);
      expect(cfg).to.contain(`  use_backend cloud_${TLS_PORT}app2runonfluxiobackend if cloud_${TLS_PORT}app2runonfluxio\n`);
      expect(cfg).to.contain(`\nbackend cloud_${TLS_PORT}app2runonfluxiobackend\n`);
    });

    it('gives an app no servers when none of its instances is allowed', () => {
      const lines = logged(() => {
        expect(serverLines(haproxyTemplate.createAppsHaproxyConfig([entry()], on(['192.0.2.99'])))).to.deep.equal([]);
      });
      expect(lines).to.deep.equal(['warn: cloud: none of its 3 instances is on the verifiedTlsApps allow-list; its backends get no servers']);
    });

    it('matches by address, whatever the port and the spelling, and the app name in any case', () => {
      const ips = [`${A}:16127`, '[2001:DB8:0:0::10]:33443'];
      const cfg = haproxyTemplate.createAppsHaproxyConfig([entry({ name: 'Cloud', ips })], on([A, '2001:db8::10']));
      expect(serverLines(cfg)).to.have.lengthOf(2);
      serverLines(cfg).forEach((line) => expect(line).to.contain(tls));
    });

    it('keeps the order of the instances, so a replicated database keeps its primary', () => {
      const servers = serverLines(haproxyTemplate.createAppsHaproxyConfig([entry({ isRdata: true })], on([C, A])));
      expect(servers).to.have.lengthOf(2);
      expect(servers[0]).to.contain(` ${A}:${TLS_PORT} `).and.not.contain(' backup');
      expect(servers[1]).to.contain(` ${C}:${TLS_PORT} `).and.contain(' backup');
    });

    it('gives a replicated database no servers when its primary is not allowed, never a replica as primary', () => {
      // The first instance is the primary: with it left out, a backup would be the first server and take writes.
      let cfg;
      const lines = logged(() => {
        [1, 2].forEach(() => {
          cfg = haproxyTemplate.createAppsHaproxyConfig([entry({ isRdata: true }), entry({ isRdata: true, domain: 'cloud.runonflux.io' })], on([B, C]));
        });
      });
      expect(serverLines(cfg)).to.deep.equal([]);
      expect(cfg).to.contain('hdr(host) cloud.runonflux.io\n');
      expect(cfg).to.not.contain(B).and.not.contain(C);
      expect(lines).to.deep.equal([
        'warn: cloud: its primary instance is not on the verifiedTlsApps allow-list; its backends get no servers, so that no replica becomes primary',
      ]);
      // The same instances without isRdata: the allowed ones serve.
      expect(serverLines(haproxyTemplate.createAppsHaproxyConfig([entry()], on([B, C])))).to.have.lengthOf(2);
    });

    it('verifies every server line of the app, whatever its custom settings', () => {
      const ips = [`${B}:16137`, `[${V6}]:33443`];
      [
        {}, { ssl: true }, { enableH2: true }, { mode: 'tcp' }, { check: false },
        { serverConfig: 'inter 30s fall 2 rise 2' }, { loadBalance: '\n  balance roundrobin' }, { isRdata: true },
      ].forEach((overrides) => {
        const cfg = haproxyTemplate.createAppsHaproxyConfig([entry({ ips, ...overrides })], on([B, V6]));
        const servers = serverLines(cfg);
        const label = JSON.stringify(overrides);
        expect(servers.length, label).to.be.at.least(2);
        servers.forEach((line) => expect(line, label).to.contain(tls).and.contain(`:${TLS_PORT} `));
        expect(cfg, label).to.not.contain('verify none');
      });
    });

    it('leaves every other app as it renders with no verified apps', () => {
      const others = () => [
        other('webapp'),
        other('tlsapp', { ssl: true, enableH2: true }),
        other('v6app', { ips: [`[${V6}]:31001`] }),
        other('dbapp', { isRdata: true }),
        other('tcpapp', { port: 31003, mode: 'tcp' }),
        other('clouddev'),
        other('cloudy'),
      ];
      const withVerified = haproxyTemplate.createAppsHaproxyConfig(others(), on([A, B, C, V6]));
      expect(withVerified).to.equal(haproxyTemplate.createAppsHaproxyConfig(others(), null));
      const mixed = haproxyTemplate.createAppsHaproxyConfig([entry(), ...others()], on([B]));
      const notCloud = (blocks) => blocks.filter((block) => !block.startsWith('cloud_'));
      expect(notCloud(backendBlocks(mixed))).to.deep.equal(backendBlocks(withVerified));
    });
  });

  describe('the TLS port', () => {
    it('serves every domain of the app from its configured port, from one backend', () => {
      const configuredApps = createConfiguredApps();
      addConfigurations(configuredApps, cloudSpec(), [`${A}:16127`, `${B}:16137`], false, on([B]));
      const entries = configuredApps.list();
      const domains = [`cloud_${HTTP_PORT}.${ZONE}`, `cloud_${TLS_PORT}.${ZONE}`, `cloud.${ZONE}`, ...cloudDomains];
      expect(entries.map((e) => e.domain)).to.have.members(domains);
      // The entries name the app's first port, as before; the render moves them.
      expect(entries.find((e) => e.domain === 'cloud.runonflux.io').port).to.equal(HTTP_PORT);

      const cfg = haproxyTemplate.createAppsHaproxyConfig(entries, on([B]));
      expect(serverLines(cfg)).to.deep.equal([
        `  server allowed0 ${B}:${TLS_PORT} check  ${tls} cookie allowed0 inter 3s fall 2 rise 2 fastinter 500`,
      ]);
      const blocks = backendBlocks(cfg);
      expect(blocks).to.have.lengthOf(1 + 4); // the app's one backend and the four fixed ones
      const acl = blocks[0].split('\n')[0].replace(/backend$/, '');
      domains.forEach((domain) => expect(cfg, domain).to.contain(`  acl ${acl} hdr(host) ${domain}\n`));
      expect(cfg).to.not.contain(A);
      expect(cfg).to.not.contain(`:${HTTP_PORT} `);
    });

    it('gives the app no servers when the port is not one of its ports', () => {
      const lines = logged(() => {
        const cfg = haproxyTemplate.createAppsHaproxyConfig([entry(), entry({ domain: 'cloud.runonflux.io' })], on([B], { port: 31444 }));
        expect(serverLines(cfg)).to.deep.equal([]);
        expect(cfg).to.contain('hdr(host) cloud.runonflux.io\n');
      });
      expect(lines).to.deep.equal([`error: cloud: verifiedTlsApps port 31444 is not one of its ports (${TLS_PORT}); its backends get no servers`]);
    });
  });

  describe('reserved domains', () => {
    const thief = (domain) => other('thief', { domain, ips: [`${A}:16127`] });

    it('leaves out any other app\'s entry for a domain of the verified app, before or after it', () => {
      const entries = [thief('cloud.runonflux.io'), entry(), entry({ domain: 'cloud.runonflux.io' }), thief('www.cloud.runonflux.com')];
      let cfg;
      const lines = logged(() => {
        cfg = haproxyTemplate.createAppsHaproxyConfig(entries, on([B]));
        haproxyTemplate.createAppsHaproxyConfig(entries, on([B]));
      });
      expect(cfg).to.not.contain('thief');
      expect(cfg).to.not.contain(A);
      expect(cfg).to.contain(`  acl cloud_${TLS_PORT}app2runonfluxio hdr(host) cloud.runonflux.io\n`);
      expect(cfg).to.not.contain('hdr(host) www.cloud.runonflux.com');
      // Once each, however many passes.
      expect(lines).to.deep.equal([
        'warn: Leaving cloud.runonflux.io of thief out: it belongs to the verified app cloud',
        'info: cloud: 2 of its 3 instances are not on the verifiedTlsApps allow-list and are left out',
        'warn: Leaving www.cloud.runonflux.com of thief out: it belongs to the verified app cloud',
      ]);
    });

    it('keeps its fixed domains from other apps where the verified app is not running', () => {
      const entries = [...cloudDomains, `cloud.${ZONE}`].map(thief);
      entries.push(other('webapp'));
      const cfg = haproxyTemplate.createAppsHaproxyConfig(entries, on([B]));
      expect(cfg).to.not.contain('thief');
      expect(cfg).to.not.contain('hdr(host) cloud');
      expect(cfg).to.contain(`hdr(host) webapp.${ZONE}\n`);
      // With the app off, the same entries are served, as before.
      expect(haproxyTemplate.createAppsHaproxyConfig(entries, off())).to.contain('hdr(host) cloud.runonflux.io\n');
    });

    it('gives the verified app its domains even when another app took them first', () => {
      const configuredApps = createConfiguredApps();
      configuredApps.push(thief('cloud.runonflux.io'));
      configuredApps.push(thief('www.cloud.runonflux.io'));
      addConfigurations(configuredApps, cloudSpec(), [`${B}:16137`], false, on([B]));
      const cloudEntries = configuredApps.list().filter((e) => e.name === 'cloud');
      expect(cloudEntries.map((e) => e.domain)).to.include.members(cloudDomains);
      expect(isVerifiedTlsApp(on([B]), 'Cloud')).to.equal(true);

      const cfg = haproxyTemplate.createAppsHaproxyConfig(configuredApps.list(), on([B]));
      expect(cfg).to.not.contain('thief');
      cloudDomains.forEach((domain) => expect(cfg).to.contain(`hdr(host) ${domain}\n`));
      serverLines(cfg).forEach((line) => expect(line).to.contain(tls));
    });

    it('gives a domain two verified apps claim to neither', () => {
      const both = { ...on([B]), clouddev: { ...on([B]).cloud } };
      const dev = (overrides) => entry({
        name: 'clouddev', appName: `clouddev_web_${TLS_PORT}`, port: TLS_PORT, ...overrides,
      });
      const entries = [entry({ domain: 'shared.example.com' }), dev({ domain: 'shared.example.com' }), dev({ domain: `clouddev.${ZONE}` })];
      const lines = logged(() => {
        const cfg = haproxyTemplate.createAppsHaproxyConfig(entries, both);
        expect(cfg).to.not.contain('shared.example.com');
        expect(cfg).to.contain(`hdr(host) clouddev.${ZONE}\n`);
      });
      expect(lines).to.include('error: Leaving shared.example.com of cloud out: more than one verified app claims it');
    });
  });

  describe('server names and sticky cookies', () => {
    it('never carry an instance address', () => {
      const cfg = haproxyTemplate.createAppsHaproxyConfig([entry({ ips: [`${A}:16127`, `${B}:16137`, `[${V6}]:16127`] })], on([V6, B, A]));
      expect(cfg).to.contain('  cookie FDMSERVERID insert preserve indirect nocache maxlife 8h\n');
      const servers = serverLines(cfg);
      expect(servers).to.have.lengthOf(3);
      servers.forEach((line) => {
        const [, name, target, ...rest] = line.trim().split(/\s+/);
        const cookie = rest[rest.indexOf('cookie') + 1];
        expect(name).to.match(/^allowed\d$/);
        expect(cookie).to.equal(name);
        expect(target).to.match(new RegExp(`:${TLS_PORT}$`));
      });
    });

    it('name each instance by its place in allowedIps, so it keeps its name as others come and go', () => {
      const names = (ips) => serverLines(haproxyTemplate.createAppsHaproxyConfig([entry({ ips })], on([A, B, C])))
        .map((line) => line.trim().split(/\s+/).slice(1, 3).join(' '));
      expect(names([`${A}:16127`, `${C}:16127`])).to.deep.equal([`allowed0 ${A}:${TLS_PORT}`, `allowed2 ${C}:${TLS_PORT}`]);
      expect(names([`${C}:16127`])).to.deep.equal([`allowed2 ${C}:${TLS_PORT}`]);
      // Two instances on one address each get a name of their own.
      expect(names([`${B}:16127`, `${B}:16137`])).to.deep.equal([`allowed1 ${B}:${TLS_PORT}`, `allowed1-2 ${B}:${TLS_PORT}`]);
    });
  });

  describe('the main FDM', () => {
    it('does not route cloud.* once cloud is a verified app', () => {
      const plain = haproxyTemplate.createMainHaproxyConfig(...MAIN, null);
      let verified;
      const lines = logged(() => {
        verified = haproxyTemplate.createMainHaproxyConfig(...MAIN, on([B]), 'cloud');
        haproxyTemplate.createMainHaproxyConfig(...MAIN, on([B]), 'cloud');
      });
      expect(verified).to.not.contain('hdr(host) cloud.');
      // Nothing else changes.
      expect(verified).to.equal(plain
        .replaceAll('  acl homerunonfluxio hdr(host) cloud.runonflux.io\n', '')
        .replaceAll('  acl homerunonfluxio hdr(host) cloud.runonflux.com\n', ''));
      expect(lines).to.deep.equal([
        'info: Not routing cloud.runonflux.io and cloud.runonflux.com: cloud is a verified app (verifiedTlsApps), served by the app FDMs',
      ]);
    });

    it('does not route them either when the setting is on but cannot be used', () => {
      [on([B], { caFile: 'relative.pem' }), on([B], { enabled: 'yes' }), on([B], { port: undefined }), { cloud: 'on' },
        on([B], { caFile: unusable.placeholder })]
        .forEach((value) => {
          const cfg = haproxyTemplate.createMainHaproxyConfig(...MAIN, value, 'cloud');
          expect(cfg, JSON.stringify(value)).to.not.contain('hdr(host) cloud.');
        });
    });

    it('routes them for a cloud UI name that is not a verified app', () => {
      const cfg = haproxyTemplate.createMainHaproxyConfig(...MAIN, on([B]), 'devcloud');
      expect(cfg).to.equal(haproxyTemplate.createMainHaproxyConfig(...MAIN, null));
    });

    it('refuses a verifiedTlsApps value that is not a map of apps', () => {
      expect(() => haproxyTemplate.createMainHaproxyConfig(...MAIN, ['cloud'], 'cloud'))
        .to.throw('verifiedTlsApps must map app names to their settings');
    });
  });

  describe('config validation', () => {
    const bad = () => [
      ['enabled that is not a boolean', { enabled: 'yes' }],
      ['enabled 1', { enabled: 1 }],
      ['no caFile', { caFile: undefined }],
      ['an empty caFile', { caFile: '' }],
      ['a relative caFile', { caFile: 'ca.pem' }],
      ['a caFile with options after it', { caFile: '/etc/ssl/ca.pem verify none' }],
      ['a caFile with a line break', { caFile: '/etc/ssl/ca.pem\n  server x 192.0.2.1:80' }],
      ['a caFile outside its directory', { caFile: '/etc/ssl/../ca.pem' }],
      ['a caFile that does not exist', { caFile: path.join(dir, 'missing.pem') }],
      ['a caFile that is an empty file', { caFile: unusable.empty }],
      ['a caFile that is a placeholder, not a certificate', { caFile: unusable.placeholder }],
      ['a caFile in DER, not PEM', { caFile: unusable.der }],
      ['a caFile whose certificate does not parse', { caFile: unusable.broken }],
      ['a caFile holding something other than certificates too', { caFile: unusable.mixed }],
      ['a caFile that is a directory', { caFile: unusable.directory }],
      ['no verifyHost', { verifyHost: undefined }],
      ['a verifyHost with options after it', { verifyHost: `${VERIFY_HOST} verify none` }],
      ['a verifyHost that is not a hostname', { verifyHost: 'localhost' }],
      ['no port', { port: undefined }],
      ['port 0', { port: 0 }],
      ['port 70000', { port: 70000 }],
      ['a port that is not a number', { port: 'https' }],
      ['a port in a list', { port: [TLS_PORT] }],
      ['allowedIps that is not a list', { allowedIps: B }],
      ['an allowed ip with a port', { allowedIps: [`${B}:${TLS_PORT}`] }],
      ['an allowed hostname', { allowedIps: ['node.example.com'] }],
      ['an allowed ip that is not a string', { allowedIps: [B, 7] }],
    ];

    it('gives an app whose settings cannot be used no servers, never unverified ones, and other apps theirs', () => {
      bad().forEach(([label, overrides]) => {
        resetReports();
        const lines = logged(() => {
          const cfg = haproxyTemplate.createAppsHaproxyConfig([entry(), other('webapp', { ips: [`${A}:16127`] })], on([B], overrides));
          const servers = serverLines(cfg);
          expect(servers, label).to.have.lengthOf(1);
          expect(servers[0], label).to.contain(` ${A}:31000 `);
          expect(cfg, label).to.not.contain(B);
          expect(cfg, label).to.not.contain('verify none');
          expect(cfg, label).to.not.contain('ca-file');
          expect(cfg, label).to.contain(`\nbackend cloud_${TLS_PORT}app2runonfluxiobackend\n`);
        });
        expect(lines, label).to.have.lengthOf(1);
        expect(lines[0], label).to.match(/^error: cloud: invalid verifiedTlsApps .*; its backends get no servers$/);
      });
    });

    it('does the same for settings that are not an object, or an app listed twice', () => {
      [{ cloud: null }, { cloud: 'yes' }, { cloud: true }, { cloud: [B] }, { ...on([B]), CLOUD: { enabled: false } }]
        .forEach((value) => {
          const cfg = haproxyTemplate.createAppsHaproxyConfig([entry()], value);
          expect(serverLines(cfg), JSON.stringify(value)).to.deep.equal([]);
          expect(cfg).to.contain(`hdr(host) cloud_${TLS_PORT}.${ZONE}\n`);
        });
    });

    it('confines a problem to its app: another verified app keeps its servers', () => {
      const value = { ...on([B]), clouddev: { enabled: true, caFile: 'relative' } };
      const cfg = haproxyTemplate.createAppsHaproxyConfig([entry(), entry({
        name: 'clouddev', appName: `clouddev_web_${TLS_PORT}`, domain: `clouddev.${ZONE}`, port: TLS_PORT,
      })], value);
      expect(serverLines(cfg)).to.deep.equal([
        `  server allowed0 ${B}:${TLS_PORT} check  ${tls} cookie allowed0 inter 3s fall 2 rise 2 fastinter 500`,
      ]);
    });

    it('logs a lasting problem once, not on every pass', () => {
      const lines = logged(() => {
        [1, 2, 3].forEach(() => haproxyTemplate.createAppsHaproxyConfig([entry()], on([B], { port: 'https' })));
      });
      expect(lines).to.deep.equal(['error: cloud: invalid verifiedTlsApps port; its backends get no servers']);
    });

    it('needs the CA file only once an instance is allowed', () => {
      const missing = path.join(dir, 'missing.pem');
      [missing, ...Object.values(unusable)].forEach((file) => {
        expect(resolveVerifiedTlsApps(on([], { caFile: file })).get('cloud'), file).to.not.have.property('problem');
      });
      expect(resolveVerifiedTlsApps(on([B], { caFile: missing })).get('cloud')).to.deep.equal({ problem: 'caFile (no such file)' });
    });

    it('takes only a regular file of PEM certificates that parse as the CA file', () => {
      const problem = (file) => resolveVerifiedTlsApps(on([B], { caFile: file })).get('cloud').problem;
      expect(problem(caFile)).to.equal(undefined);
      expect(problem(unusable.empty)).to.equal('caFile (no PEM certificate)');
      expect(problem(unusable.placeholder)).to.equal('caFile (no PEM certificate)');
      expect(problem(unusable.der)).to.equal('caFile (no PEM certificate)');
      expect(problem(unusable.broken)).to.equal('caFile (a certificate that does not parse)');
      expect(problem(unusable.mixed)).to.equal('caFile (not only PEM certificates)');
      expect(problem(unusable.directory)).to.equal('caFile (not a file)');
      expect(problem(`${caFile}/x`)).to.equal('caFile (no such file)');
      // A bundle of several certificates is fine.
      const bundle = path.join(dir, 'bundle.pem');
      fs.writeFileSync(bundle, `${fs.readFileSync(caFile, 'latin1')}\n${fs.readFileSync(caFile, 'latin1')}`);
      expect(problem(bundle)).to.equal(undefined);
    });

    it('refuses a verifiedTlsApps value that is not a map of apps', () => {
      [['cloud'], 'cloud', 1].forEach((value) => {
        expect(() => haproxyTemplate.createAppsHaproxyConfig([entry()], value), JSON.stringify(value))
          .to.throw('verifiedTlsApps must map app names to their settings');
        expect(isVerifiedTlsApp(value, 'cloud')).to.equal(false);
      });
    });

    it('reads a missing verifiedTlsApps as no verified apps', () => {
      expect(resolveVerifiedTlsApps(undefined).size).to.equal(0);
      expect(resolveVerifiedTlsApps(null).size).to.equal(0);
    });
  });

  describe('addressOf', () => {
    it('spells each address one way', () => {
      expect(addressOf(A)).to.equal(A);
      expect(addressOf(`${A}:16127`)).to.equal(A);
      expect(addressOf('2001:DB8:0:0::10')).to.equal(V6);
      expect(addressOf('[2001:db8::10]')).to.equal(V6);
      expect(addressOf('[2001:DB8::10]:33443')).to.equal(V6);
    });

    it('names no address for anything else', () => {
      ['node.example.com', `${A}:1:2`, '', '[node]:80', 'fe80::1%eth0', null, 7]
        .forEach((value) => expect(addressOf(value), JSON.stringify(value)).to.equal(null));
    });
  });
});

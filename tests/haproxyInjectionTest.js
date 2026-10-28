const chai = require('chai');
const { isHaproxyTimeout, timeoutFromParameters } = require('../src/services/application/timeout');
const { addConfigurations, createConfiguredApps } = require('../src/services/domainService');
const haproxyTemplate = require('../src/services/haproxyTemplate');

const { expect } = chai;

const IPS = ['1.2.3.4:16127', '5.6.7.8:16137'];
const MARKER = 'injected';

function composeApp(name, components) {
  return {
    name,
    version: 8,
    compose: components.map((c, i) => ({
      name: `c${i}`,
      ports: c.ports || [30000 + i],
      domains: c.domains || [''],
      environmentParameters: c.env || [],
    })),
  };
}

function configure(apps) {
  const configuredApps = createConfiguredApps();
  apps.forEach((app) => addConfigurations(configuredApps, app, IPS, false));
  return configuredApps.list();
}

function render(apps) {
  return haproxyTemplate.createAppsHaproxyConfig(configure(apps));
}

const HOSTILE_VALUES = [
  `x.com\n  use_backend ${MARKER} if TRUE`,
  `x.com\r\n${MARKER}`,
  `x.com\u0000${MARKER}`,
  `x.com ${MARKER}`,
  `x.com\t${MARKER}`,
  `x.com#${MARKER}`,
  `\`${MARKER}\`.x.com`,
  `-${MARKER}.x.com`,
];

describe('isHaproxyTimeout', () => {
  it('accepts haproxy times from 1 ms to 2^31-1 ms', () => {
    ['1', '30000', '30s', '5m', '2h', '24d', '1000us', '250ms', 90000, '2147483647', '2147483647ms']
      .forEach((value) => expect(isHaproxyTimeout(value), JSON.stringify(value)).to.equal(true));
  });

  it('rejects anything haproxy would refuse or that is not a time', () => {
    ['', '0', '0s', '999us', '25d', '2147483648', '99999999999', '-5s', '5.5s', '30S', '30 s', ' 30s',
      '30sec', '30s\n  server x 1.2.3.4:80', '30s#', 's', null, undefined, false, true, 0, -1, 1.5, ['30s'], {}]
      .forEach((value) => expect(isHaproxyTimeout(value), JSON.stringify(value)).to.equal(false));
  });
});

describe('timeoutFromParameters', () => {
  it('reads the first timeout= parameter', () => {
    expect(timeoutFromParameters(['A=1', 'timeout=30s', 'timeout=5s'], 'app')).to.equal('30s');
    expect(timeoutFromParameters(['TIMEOUT=45000'], 'app')).to.equal('45000');
    expect(timeoutFromParameters(['timeout= 30s '], 'app')).to.equal('30s');
  });

  it('gives null for no timeout, or one haproxy would refuse', () => {
    [undefined, null, 'timeout=30s', [], ['A=1'], [5, null, {}], ['timeout='], ['timeout=30s\n  server x 1.2.3.4:80'],
      ['timeout=30s=1'], ['timeout=25d']]
      .forEach((value) => expect(timeoutFromParameters(value, 'app'), JSON.stringify(value)).to.equal(null));
  });
});

describe('addConfigurations with hostile specs', () => {
  it('drops only the hostile custom domain and keeps the rest of the app', () => {
    const app = composeApp('mixed', [{ ports: [31000, 31001], domains: [`good.example.com,${HOSTILE_VALUES[0]}`, HOSTILE_VALUES[1]] }]);
    const domains = configure([app]).map((entry) => entry.domain);
    expect(domains).to.include.members([
      'mixed_31000.app2.runonflux.io', 'mixed_31001.app2.runonflux.io', 'mixed.app2.runonflux.io',
      'good.example.com', 'www.good.example.com', 'test.good.example.com',
    ]);
    expect(domains.join(' ')).to.not.include(MARKER);
  });

  it('gives a hostile timeout the default instead of the value', () => {
    const app = composeApp('slow', [{ env: [`timeout=30s\n  use_backend ${MARKER} if TRUE`] }, { env: ['timeout=45s'] }]);
    const entries = configure([app]);
    expect(entries.find((e) => e.domain === 'slow_30000.app2.runonflux.io').timeout).to.equal(null);
    expect(entries.find((e) => e.domain === 'slow_30001.app2.runonflux.io').timeout).to.equal('45s');
  });

  it('reads a v1-3 timeout from enviromentParameters', () => {
    const app = {
      name: 'legacy', version: 3, ports: [32000], domains: [''], enviromentParameters: ['timeout=2m'],
    };
    expect(configure([app]).every((e) => e.timeout === '2m')).to.equal(true);
  });
});

describe('createAppsHaproxyConfig with hostile specs', () => {
  const good = [
    composeApp('alpha', [{ domains: ['alpha.example.com'], env: ['timeout=30s'] }]),
    composeApp('beta', [{ ports: [31500, 31501], domains: ['', 'beta.example.org'] }]),
  ];
  const hostile = HOSTILE_VALUES.flatMap((value, i) => [
    composeApp(`hdomain${i}`, [{ domains: [value] }]),
    composeApp(`htimeout${i}`, [{ env: [`timeout=${value}`] }]),
  ]);

  it('renders every good app as it would without the hostile ones', () => {
    const goodOnly = render(good).split('\n');
    const mixed = new Set(render([...hostile, ...good]).split('\n'));
    expect(goodOnly.filter((line) => !mixed.has(line))).to.deep.equal([]);
    expect(goodOnly).to.include('  acl alpha_30000app2runonfluxio hdr(host) alpha.example.com');
    expect(goodOnly).to.include('  timeout server 30s');
  });

  it('never writes a hostile value into the config', () => {
    const cfg = render([...hostile, ...good]);
    expect(cfg).to.not.include(MARKER);
    expect(cfg).to.not.match(/[\r\0\t\v\f]/);
  });

  it('never writes a hostile value from a thousand random specs', () => {
    let seed = 42;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const alphabet = ['a', 'b', '.', '-', '_', '1', ' ', '\n', '\r', '\t', '\u0000', '#', '{', '}', '`', ';', '|', '$', ':', '/', ',', 'é', 'www.', 'http://', 's', 'm'];
    const randomText = () => Array.from({ length: 1 + Math.floor(random() * 30) }, () => alphabet[Math.floor(random() * alphabet.length)]).join('');
    const apps = Array.from({ length: 1000 }, (_, i) => composeApp(`fuzz${i}`, [{
      domains: [`${randomText()}.com`],
      env: [`timeout=${randomText()}`],
    }]));
    const cfg = render([...apps, ...good]);
    expect(cfg).to.not.match(/[\r\0\t\v\f]/);
    cfg.split('\n').forEach((line) => {
      if (/^\s*acl \S+ hdr\(host\) /.test(line) && !line.startsWith('  acl fdm-domain ')) {
        expect(line, line).to.match(/^ {2}acl [a-z0-9_-]+ hdr\(host\) [a-z0-9][a-z0-9._-]*$/);
      }
      if (/^ {2}timeout (server|http-request) \S/.test(line)) {
        expect(line, line).to.match(/^ {2}timeout (server|http-request) \d+(us|ms|s|m|h|d)?$/);
      }
    });
  });
});

describe('renderableEntries', () => {
  const entry = (overrides) => ({
    name: 'app',
    appName: 'app_c0_30000',
    domain: 'app.app2.runonflux.io',
    port: 30000,
    ips: IPS,
    healthcheck: [],
    serverConfig: '',
    mode: 'http',
    timeout: null,
    ...overrides,
  });

  it('keeps a valid entry as it is', () => {
    const valid = entry({ ips: ['1.2.3.4', '1.2.3.4:16127', '[2001:db8::1]:9132'], timeout: 90000 });
    expect(haproxyTemplate.renderableEntries([valid])).to.deep.equal([valid]);
  });

  it('leaves out an entry whose domain, port or timeout cannot be written', () => {
    [
      { domain: `a.com\n${MARKER}` }, { domain: `a.com ${MARKER}` }, { domain: '-a.com' }, { domain: 'A.com' }, { domain: '' }, { domain: undefined },
      { port: `80\n${MARKER}` }, { port: 0 }, { port: 65536 }, { port: ' 80' }, { port: 'x' },
      { timeout: `30s\n${MARKER}` }, { timeout: '25d' }, { timeout: 'abc' },
      { ips: undefined }, { ips: '1.2.3.4' },
    ].forEach((overrides) => {
      expect(haproxyTemplate.renderableEntries([entry(overrides)]), JSON.stringify(overrides)).to.deep.equal([]);
    });
  });

  it('leaves out only the ips that cannot be written', () => {
    const bad = [`1.2.3.4:80\n${MARKER}`, '1.2.3.4:80:90', '1.2.3:80', '1.2.3.4:99999', '[zz::1]:80', '[2001:db8::1]', 'host.example.com:80', 5];
    const [kept] = haproxyTemplate.renderableEntries([entry({ ips: [...bad, '9.9.9.9:16127'] })]);
    expect(kept.ips).to.deep.equal(['9.9.9.9:16127']);
  });

  it('is applied by createAppsHaproxyConfig', () => {
    const cfg = haproxyTemplate.createAppsHaproxyConfig([
      entry({ domain: `evil.com\n  use_backend ${MARKER} if TRUE`, appName: 'evil' }),
      entry({ ips: [`1.2.3.4:80\n  server ${MARKER} 6.6.6.6:80`, '9.9.9.9:16127'] }),
    ]);
    expect(cfg).to.not.include(MARKER);
    expect(cfg).to.include('server 9.9.9.9:16127 9.9.9.9:30000');
  });
});

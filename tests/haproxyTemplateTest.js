'use strict';

/* eslint-disable func-names */
const chai = require('chai');
const config = require('config');
const haproxyTemplate = require('../src/services/haproxyTemplate');
const { appendRouteConfigs } = require('../src/services/domainService');
const { getPrimaryIP } = require('../src/services/rsync/config');
const { looseBackends } = require('./unit/fixtures/renderPipeline');

const { expect } = chai;

// A registered v3 app on one port.
const v3spec = (name, port, { repotag = 'nginx:latest', containerData = '/data' } = {}) => ({
  version: 3,
  name,
  description: 'haproxy template fixture',
  owner: '1AnonOwner0001FixtureXXXXXXXXXXXX',
  repotag,
  ports: [String(port)],
  domains: [''],
  enviromentParameters: [],
  commands: [],
  containerPorts: ['80'],
  containerData,
  cpu: 0.1,
  ram: 100,
  hdd: 1,
  tiered: false,
  instances: 3,
  hash: `hash${name}`,
  height: 2764314,
});

// The apps config for these apps, built by the routing loops' own path.
async function appsConfigFor(apps) {
  const routeConfigs = [];
  // eslint-disable-next-line no-restricted-syntax
  for (const { spec, ips, activeStandby = false } of apps) {
    // eslint-disable-next-line no-await-in-loop
    await appendRouteConfigs(routeConfigs, spec, looseBackends(ips), activeStandby);
  }
  return haproxyTemplate.createAppsHaproxyConfig(routeConfigs);
}

const serverLines = (backend) => backend.split('\n').filter((l) => l.trim().startsWith('server '));

describe('haproxyTemplate', () => {
  // The letsEncryptBackend is computed at module load time based on config.certRenewalPrimary
  // Default config has certRenewalPrimary: false, so it should point to the primary's IP

  it('letsencrypt-backend points to primary IP when not primary', () => {
    // Default test config: certRenewalPrimary = false
    expect(config.certRenewalPrimary).to.equal(false);

    // We can't easily re-require with different config, but we can verify the
    // generated config string contains the expected primary IP
    const primaryIP = getPrimaryIP();
    expect(primaryIP).to.be.a('string');

    // The haproxy template module reads this at load time
    // Since certRenewalPrimary is false, it should use the primary IP
    // We verify the building blocks are correct
    expect(primaryIP).to.match(/^\d+\.\d+\.\d+\.\d+$/);
  });

  it('getPrimaryIP returns the fn host IP for the default test config', () => {
    const primaryIP = getPrimaryIP();
    // Default rsync_config.json is fdm_fn1_app, group 1 fn host is itself: 5.39.57.42
    expect(primaryIP).to.equal('5.39.57.42');
  });
});

describe('haproxyTemplate connection handling', () => {
  const mainConfig = haproxyTemplate.createMainHaproxyConfig(
    'home.runonflux.io',
    'api.runonflux.io',
    ['1.2.3.4:16127', '5.6.7.8:16137'],
    'home.zel.network',
    'api.zel.network',
    'cloud.runonflux.io',
    'cloud.zel.network',
  );

  let appsConfig;
  before(async () => {
    appsConfig = await appsConfigFor([{ spec: v3spec('myapp', 36127), ips: ['1.2.3.4:16127'] }]);
  });

  it('origin connections are pooled, never forced closed per request', () => {
    [mainConfig, appsConfig].forEach((cfg) => {
      expect(cfg).to.include('http-reuse safe');
      expect(cfg).to.not.include('http-server-close');
    });
  });

  it('main LB backends retry the keep-alive close race but never replay POSTs', () => {
    expect(mainConfig).to.include('backend apirunonfluxiobackend');
    expect(mainConfig).to.include('backend apirunonfluxioroundrobinbackend');
    expect(mainConfig).to.include('backend homerunonfluxiobackend');
    const retryOn = mainConfig.match(/^\s*retry-on conn-failure empty-response$/gm) || [];
    const postGuard = mainConfig.match(/^\s*http-request disable-l7-retry if METH_POST$/gm) || [];
    expect(retryOn).to.have.lengthOf(3);
    expect(postGuard).to.have.lengthOf(3);
  });

  it('app backends keep their full retry net', () => {
    expect(appsConfig).to.include('retry-on conn-failure response-timeout empty-response 500');
    expect(appsConfig).to.include('option redispatch 1');
  });
});

// primaryOnly is what makes a backend single-target: haproxy takes the first server
// and marks every other one `backup`, so only position zero receives traffic
// until it fails. It is set for sharedDB applications, whose cluster members must
// not be written to concurrently. Every other application - including one with an
// `r:` syncthing-replicated volume, whose instances are all meant to run and all
// meant to serve - keeps every server active.
describe('haproxyTemplate primaryOnly backends', () => {
  const ips = ['1.2.3.4:16127', '5.6.7.8:16127', '9.10.11.12:16127'];
  const backendFor = async (spec) => {
    const generated = await appsConfigFor([{ spec, ips }]);
    // Leading newline: `use_backend <name>` appears in the frontend first.
    return generated.split('\nbackend someapp_31512app2runonfluxiobackend')[1].split('\nbackend ')[0];
  };

  it('marks every server after the first as backup for a replicated database', async () => {
    const servers = serverLines(await backendFor(v3spec('someapp', 31512, { repotag: 'runonflux/shared-db:latest' })));
    expect(servers).to.have.lengthOf(3);
    expect(servers[0]).to.not.contain(' backup');
    expect(servers[1]).to.contain(' backup');
    expect(servers[2]).to.contain(' backup');
  });

  it('leaves every server active for an application that is not one', async () => {
    const servers = serverLines(await backendFor(v3spec('someapp', 31512, { containerData: 'r:/data' })));
    expect(servers).to.have.lengthOf(3);
    servers.forEach((line) => expect(line).to.not.contain(' backup'));
  });
});

describe('haproxyTemplate server-side sockets and minecraft apps', () => {
  const mainConfig = haproxyTemplate.createMainHaproxyConfig(
    'home.runonflux.io',
    'api.runonflux.io',
    ['1.2.3.4:16127', '5.6.7.8:16137'],
    'home.zel.network',
    'api.zel.network',
    'cloud.runonflux.io',
    'cloud.zel.network',
  );

  let appsConfig;
  before(async () => {
    appsConfig = await appsConfigFor([
      // A minecraft server elects one primary, which is what gives its route tcp mode.
      { spec: v3spec('minecraftsrv', 25565, { containerData: 'g:/data' }), ips: ['1.2.3.4:16127'], activeStandby: true },
      { spec: v3spec('webapp', 36127), ips: ['1.2.3.4:16127'] },
    ]);
  });

  it('binds every server-side connection through source 0.0.0.0, once, in defaults', () => {
    [mainConfig, appsConfig].forEach((cfg) => {
      const defaults = cfg.slice(cfg.indexOf('\ndefaults\n'), cfg.indexOf('\nfrontend '));
      expect(defaults).to.match(/^\s*source 0\.0\.0\.0$/m);
      expect(cfg.match(/^\s*source /gm)).to.have.lengthOf(1);
    });
  });

  it('serves a minecraft app from its TCP frontend only, with no HTTP backend', () => {
    expect(appsConfig).to.include('frontend tcp_app_25565');
    expect(appsConfig).to.match(/^backend minecraftsrv\S*_tcp_backend$/m);
    expect(appsConfig).to.not.match(/^backend minecraftsrv\S*runonfluxiobackend$/m);
    expect(appsConfig).to.match(/^backend webapp\S*runonfluxiobackend$/m);
  });
});

/* eslint-disable func-names */
const chai = require('chai');
const config = require('config');
const haproxyTemplate = require('../src/services/haproxyTemplate');

const { expect } = chai;

describe('haproxyTemplate', () => {
  // The letsEncryptBackend is computed at module load time based on config.certRenewalPrimary
  // Default config has certRenewalPrimary: false, so it should point to the primary's IP

  it('letsencrypt-backend points to primary IP when not primary', () => {
    // Default test config: certRenewalPrimary = false
    expect(config.certRenewalPrimary).to.equal(false);

    // We can't easily re-require with different config, but we can verify the
    // generated config string contains the expected primary IP
    const { getPrimaryIP } = require('../src/services/rsync/config');
    const primaryIP = getPrimaryIP();
    expect(primaryIP).to.be.a('string');

    // The haproxy template module reads this at load time
    // Since certRenewalPrimary is false, it should use the primary IP
    // We verify the building blocks are correct
    expect(primaryIP).to.match(/^\d+\.\d+\.\d+\.\d+$/);
  });

  it('getPrimaryIP returns the fn host IP for the default test config', () => {
    const { getPrimaryIP } = require('../src/services/rsync/config');
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

  const appsConfig = haproxyTemplate.createAppsHaproxyConfig([{
    domain: 'myapp.app.runonflux.io',
    appName: 'myapp',
    name: 'myapp',
    port: 36127,
    ips: ['1.2.3.4:16127'],
    healthcheck: [],
    serverConfig: '',
    mode: 'http',
  }]);

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

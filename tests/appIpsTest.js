/* eslint-disable func-names */
const chai = require('chai');

const { expect } = chai;

const domainService = require('../src/services/domainService');
const apiService = require('../src/services/api');

// Minimal Express res double that captures status + json payload.
function makeRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

describe('getAppIpsAPI - /appips port preservation', () => {
  let originalGetConfiguredApps;

  beforeEach(() => {
    originalGetConfiguredApps = domainService.getConfiguredApps;
  });

  afterEach(() => {
    domainService.getConfiguredApps = originalGetConfiguredApps;
  });

  function stubConfiguredApps(apps) {
    domainService.getConfiguredApps = () => ({
      nonGApps: apps,
      gApps: [],
      nonGAppsInitialized: true,
      gAppsInitialized: true,
    });
  }

  it('returns the full ip:port socket for a UPnP (non-default-port) master', () => {
    stubConfiguredApps([
      { name: 'valheim1777035136949', ips: ['90.228.196.203:16157'] },
    ]);
    const res = makeRes();

    apiService.getAppIpsAPI({ params: { appname: 'valheim1777035136949' } }, res);

    expect(res.statusCode).to.equal(200);
    expect(res.body.status).to.equal('success');
    // The port must survive - this is what lets FluxOS match a UPnP master.
    expect(res.body.data.ips).to.deep.equal(['90.228.196.203:16157']);
    expect(res.body.data.count).to.equal(1);
  });

  it('passes a bare default-port IP through unchanged', () => {
    stubConfiguredApps([
      { name: 'someapp', ips: ['10.0.0.5'] },
    ]);
    const res = makeRes();

    apiService.getAppIpsAPI({ params: { appname: 'someapp' } }, res);

    expect(res.body.data.ips).to.deep.equal(['10.0.0.5']);
  });

  it('dedupes identical socket addresses across components', () => {
    stubConfiguredApps([
      { name: 'multi', ips: ['1.2.3.4:16157', '5.6.7.8:16137'] },
      { name: 'multi', ips: ['1.2.3.4:16157'] },
    ]);
    const res = makeRes();

    apiService.getAppIpsAPI({ params: { appname: 'multi' } }, res);

    expect(res.body.data.ips).to.deep.equal(['1.2.3.4:16157', '5.6.7.8:16137']);
    expect(res.body.data.count).to.equal(2);
  });

  it('preserves distinct ports for the same IP (does not collapse by IP)', () => {
    // Two different sockets that share an IP must both survive - the pre-fix
    // .split(':')[0] collapsed these into a single bare IP.
    stubConfiguredApps([
      { name: 'app', ips: ['1.2.3.4:16157', '1.2.3.4:16137'] },
    ]);
    const res = makeRes();

    apiService.getAppIpsAPI({ params: { appname: 'app' } }, res);

    expect(res.body.data.ips).to.deep.equal(['1.2.3.4:16157', '1.2.3.4:16137']);
    expect(res.body.data.count).to.equal(2);
  });

  it('404s when the app is not configured', () => {
    stubConfiguredApps([]);
    const res = makeRes();

    apiService.getAppIpsAPI({ params: { appname: 'missing' } }, res);

    expect(res.statusCode).to.equal(404);
  });
});

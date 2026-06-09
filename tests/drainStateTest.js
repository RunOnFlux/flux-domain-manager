/* eslint-disable func-names */
const chai = require('chai');

const { expect } = chai;

const domainService = require('../src/services/domainService');
const haproxyTemplate = require('../src/services/haproxyTemplate');

describe('load-balancer drain state', () => {
  describe('classifyBackends', () => {
    it('drops stopping backends, keeps active and draining, and collects draining IPs', () => {
      const { routable, drainingIps } = domainService.classifyBackends([
        { ip: '1.1.1.1:16127', state: 'active' },
        { ip: '2.2.2.2:16127', state: 'draining' },
        { ip: '3.3.3.3:16127', state: 'stopping' },
      ]);
      expect(routable.map((l) => l.ip)).to.deep.equal(['1.1.1.1:16127', '2.2.2.2:16127']);
      expect(drainingIps).to.deep.equal(['2.2.2.2:16127']);
    });

    it('treats a missing state as active (back-compat with old nodes)', () => {
      const { routable, drainingIps } = domainService.classifyBackends([
        { ip: '1.1.1.1:16127' },
      ]);
      expect(routable.map((l) => l.ip)).to.deep.equal(['1.1.1.1:16127']);
      expect(drainingIps).to.deep.equal([]);
    });

    it('preserves the original order of routable backends', () => {
      const { routable } = domainService.classifyBackends([
        { ip: 'b:1', state: 'active' },
        { ip: 'a:1', state: 'draining' },
        { ip: 'c:1', state: 'active' },
      ]);
      expect(routable.map((l) => l.ip)).to.deep.equal(['b:1', 'a:1', 'c:1']);
    });
  });

  describe('generateDomainBackend disabled keyword', () => {
    const baseApp = (overrides) => ({
      domain: 'myapp.example.com',
      port: 31000,
      healthcheck: [],
      serverConfig: '',
      check: false,
      ssl: false,
      ...overrides,
    });

    const serverLineFor = (cfg, host) => cfg
      .split('\n')
      .find((line) => line.includes('server') && line.includes(host));

    it('disables a draining backend and leaves an active one in rotation', () => {
      const cfg = haproxyTemplate.generateDomainBackend(baseApp({
        ips: ['1.2.3.4:16127', '5.6.7.8:16127'],
        drainingIps: ['5.6.7.8:16127'],
      }), 'http');
      expect(serverLineFor(cfg, '1.2.3.4')).to.not.include('disabled');
      expect(serverLineFor(cfg, '5.6.7.8')).to.include('disabled');
    });

    it('emits no disabled keyword when nothing is draining', () => {
      const cfg = haproxyTemplate.generateDomainBackend(baseApp({
        ips: ['1.2.3.4:16127'],
        drainingIps: [],
      }), 'http');
      expect(cfg).to.not.include('disabled');
    });

    it('tolerates a config without a drainingIps field', () => {
      const cfg = haproxyTemplate.generateDomainBackend(baseApp({
        ips: ['1.2.3.4:16127'],
      }), 'http');
      expect(cfg).to.not.include('disabled');
    });
  });
});

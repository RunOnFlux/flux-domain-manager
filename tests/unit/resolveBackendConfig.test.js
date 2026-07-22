// resolveBackendConfig collapses the legacy-vs-v9 trichotomy into concrete backend
// directives so the renderer stays version-blind. Legacy routes (no v9 tunables) must
// resolve to the haproxy-historical defaults; v9 routes to the owner's values.
const chai = require('chai');
const { resolveBackendConfig } = require('../../src/services/haproxy/resolveBackendConfig');

const { expect } = chai;

const legacy = (extra) => ({
  ips: ['1.2.3.4:16127', '5.6.7.8:16127'], check: true, syncFirst: false, healthcheck: [], ...extra,
});

const v9 = (extra) => ({
  ips: ['1.2.3.4:16127', '5.6.7.8:16127'],
  check: true,
  syncFirst: false,
  balancing: 'leastconn',
  maxConnectionsPerServer: 500,
  timeouts: {
    connect: '5s', server: '90s', tunnel: '3600s', httpRequest: '10s',
  },
  retries: { count: 3, retryOn: ['conn-failure'], redispatch: true },
  stickySessions: { cookieName: 'MYSESS', maxIdle: '30m', maxLife: '8h' },
  healthCheck: {
    method: 'GET', path: '/health', expectedStatus: '200-399', interval: '5s', rise: 2, fall: 3,
  },
  backendTls: { verify: 'none' },
  ...extra,
});

describe('resolveBackendConfig', () => {
  describe('legacy (no v9 tunables)', () => {
    it('round-robins with the FDMSERVERID affinity cookie when there is more than one backend', () => {
      const cfg = resolveBackendConfig(legacy(), 'http');
      expect(cfg.isV9).to.equal(false);
      expect(cfg.balanceLines).to.deep.equal([
        'balance roundrobin',
        'cookie FDMSERVERID insert preserve indirect nocache maxlife 8h',
      ]);
    });

    it('omits the affinity cookie for a single backend', () => {
      const cfg = resolveBackendConfig(legacy({ ips: ['1.2.3.4:16127'] }), 'http');
      expect(cfg.balanceLines).to.deep.equal(['balance roundrobin']);
    });

    it('honors an explicit customConfig balance directive', () => {
      const cfg = resolveBackendConfig(legacy({ loadBalance: '\n  balance source' }), 'http');
      expect(cfg.balanceLines).to.deep.equal(['balance source']);
    });

    it('emits no balance in tcp mode', () => {
      expect(resolveBackendConfig(legacy(), 'tcp').balanceLines).to.deep.equal([]);
    });

    it('uses the historical timeouts/retries and server timing', () => {
      const cfg = resolveBackendConfig(legacy(), 'http');
      expect(cfg.onceLines).to.deep.equal([
        'timeout http-request 15s',
        'timeout server 25s',
        'retries 3',
        'retry-on conn-failure response-timeout empty-response 500',
        'option redispatch 1',
      ]);
      expect(cfg.serverTiming).to.equal('inter 3s fall 2 rise 2 fastinter 500');
      expect(cfg.serverMaxconn).to.equal('');
    });

    it('shortens the server timeout for ordered (syncFirst) backups', () => {
      const cfg = resolveBackendConfig(legacy({ syncFirst: true }), 'http');
      expect(cfg.onceLines).to.include('timeout server 20s');
    });
  });

  describe('v9 (owner-declared tunables)', () => {
    it('renders the owner algorithm, cookie, probe, granular timeouts and retries', () => {
      const cfg = resolveBackendConfig(v9(), 'http');
      expect(cfg.isV9).to.equal(true);
      expect(cfg.balanceLines).to.deep.equal([
        'balance leastconn',
        'cookie MYSESS insert indirect nocache maxidle 30m maxlife 8h',
      ]);
      expect(cfg.healthCheckLines).to.deep.equal([
        'option httpchk GET /health',
        'http-check expect status 200-399',
      ]);
      expect(cfg.onceLines).to.deep.equal([
        'timeout connect 5s',
        'timeout server 90s',
        'timeout tunnel 3600s',
        'timeout http-request 10s',
        'retries 3',
        'retry-on conn-failure',
        'option redispatch',
      ]);
      expect(cfg.serverTiming).to.equal('inter 5s rise 2 fall 3');
      expect(cfg.serverMaxconn).to.equal('maxconn 500');
      expect(cfg.serverSsl).to.equal('ssl verify none');
    });

    it('drops the cookie, probe, server timing and TLS when the toggles are off (null)', () => {
      const cfg = resolveBackendConfig(v9({ stickySessions: null, healthCheck: null, backendTls: null }), 'http');
      expect(cfg.balanceLines).to.deep.equal(['balance leastconn']);
      expect(cfg.healthCheckLines).to.deep.equal([]);
      expect(cfg.serverTiming).to.equal('');
      expect(cfg.serverSsl).to.equal('');
      expect(cfg.stickyV9).to.equal(null);
    });

    it('omits retry-on and redispatch when retries are disabled', () => {
      const cfg = resolveBackendConfig(v9({ retries: { count: 0, retryOn: [], redispatch: false } }), 'http');
      expect(cfg.onceLines).to.include('retries 0');
      expect(cfg.onceLines).to.not.include.members(['retry-on ', 'option redispatch']);
      expect(cfg.onceLines.some((l) => l.startsWith('retry-on'))).to.equal(false);
    });
  });
});

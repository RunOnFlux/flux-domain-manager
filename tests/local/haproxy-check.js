// Validate rendered v9 HTTP backends against real haproxy (`haproxy -c`). Local/dev
// only: needs docker + the haproxy:2.9 image. The committed unit test asserts the
// directive strings; this proves haproxy actually accepts them, across the toggle
// variants. Usage (from repo root): node tests/local/haproxy-check.js
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { generateDomainBackend } = require('../../src/services/haproxyTemplate');

// A resolved v9 route config (as buildRouteConfigs produces): domain + backend IPs +
// the fully-filled loadBalancing tunables. ips are host:apiPort; port is the hostPort.
const baseRoute = {
  name: 'shop',
  appName: 'shop_web_31000',
  domain: 'shop.example.com',
  port: 31000,
  ips: ['172.30.0.11:16127', '172.30.0.12:16127'],
  syncFirst: false,
  check: true,
  balancing: 'leastconn',
  maxConnectionsPerServer: 500,
  timeouts: {
    server: '45s', connect: '5s', httpRequest: '10s', tunnel: '3600s',
  },
  retries: { count: 5, retryOn: ['conn-failure', '503'], redispatch: true },
  stickySessions: { cookieName: 'SRVID', maxIdle: '30m', maxLife: '8h' },
  healthCheck: {
    method: 'GET', expectedStatus: '200-399', interval: '5s', timeout: '3s', rise: 2, fall: 3, path: '/health',
  },
  backendTls: null,
};

const variants = {
  full: baseRoute,
  'toggles-off': { ...baseRoute, stickySessions: null, healthCheck: null },
  'backend-tls': { ...baseRoute, backendTls: { verify: 'none' } },
  roundrobin: { ...baseRoute, balancing: 'roundrobin', retries: { count: 0, retryOn: [], redispatch: false } },
};

const harness = (backend, backendName) => `global
  maxconn 4096
defaults
  mode http
  timeout connect 5s
  timeout client 30s
  timeout server 30s
frontend fe
  bind *:8080
  default_backend ${backendName}
${backend}
`;

let ok = true;
// eslint-disable-next-line no-restricted-syntax
for (const [label, route] of Object.entries(variants)) {
  const backend = generateDomainBackend(route, 'http');
  const backendName = `${route.domain.split('.').join('')}backend`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fdm-hap-'));
  const cfg = path.join(dir, 'h.cfg');
  fs.writeFileSync(cfg, harness(backend, backendName));
  try {
    execFileSync('docker', ['run', '--rm', '-v', `${cfg}:/cfg:ro`, 'haproxy:2.9', 'haproxy', '-c', '-f', '/cfg'], { stdio: 'pipe' });
    console.log(`✓ ${label}: valid`);
  } catch (e) {
    ok = false;
    console.log(`✗ ${label}: INVALID\n${e.stderr ? e.stderr.toString() : e.message}`);
  }
}
process.exit(ok ? 0 : 1);

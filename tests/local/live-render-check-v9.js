// Prove real haproxy 2.9 accepts the v9 scheme output: build a synthetic v9 app that
// exercises all four schemes (httpsRedirect / httpsOnly / httpOnly / httpPassthrough)
// across components with the full tunable set, run the pipeline, and haproxy -c it.
// The committed unit test (tests/unit/v9Schemes.test.js) asserts the directive strings;
// this proves haproxy actually parses them (incl. the tcp SNI router + loopback
// terminating listener). Local/dev only: needs docker + the haproxy:2.9 image.
// Usage (from repo root): node tests/local/live-render-check-v9.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { buildRouteConfigs } = require('../../src/services/haproxy/buildRouteConfigs');
const { createAppsHaproxyConfig } = require('../../src/services/haproxyTemplate');
const specLibs = require('../../src/services/flux/specLibs');

const component = (name, hostPort, lb) => ({
  name,
  description: name,
  image: 'nginx:latest',
  cpu: 0.5,
  memory: 300,
  rootFsGb: 2,
  persistentStorage: { sizeGb: 5 },
  ports: { web: { containerPort: 80, hostPort } },
  loadBalancing: { web: { provider: 'haproxy', mode: 'http', ...lb } },
});

const submission = {
  version: 9,
  name: 'schemeapp',
  description: 'all schemes',
  owner: '16dNCFf7nR3nx5iwn2RQMBw6KcJXkE3JC1',
  ttl: 2592000,
  contacts: { email: ['a@b.com'] },
  instances: 3,
  components: {
    red: component('red', 31000, {
      scheme: 'httpsRedirect',
      customDomains: ['red.example.com'],
      managedCertificates: true,
      balancing: 'leastconn',
      maxConnectionsPerServer: 500,
      timeouts: { server: '45s' },
      stickySessions: { cookieName: 'SRVID' },
      healthCheck: { path: '/health' },
      backendTls: { verify: 'none' },
      retries: { count: 5, retryOn: ['conn-failure', '503'] },
    }),
    only: component('only', 31001, { scheme: 'httpsOnly', customDomains: ['only.example.com'], managedCertificates: true }),
    plain: component('plain', 31002, { scheme: 'httpOnly', customDomains: ['plain.example.com'] }),
    thru: component('thru', 31003, {
      scheme: 'httpPassthrough', customDomains: ['thru.example.com'], balancing: 'roundrobin', healthCheck: {},
    }),
  },
};

// Throwaway asset files so `haproxy -c` reaches real config validation.
function writeAssets(dir) {
  fs.mkdirSync(path.join(dir, 'errors'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'fluxapps'), { recursive: true });
  fs.copyFileSync(path.join(__dirname, '../../deployment/haproxy_minecraft.lua'), path.join(dir, 'haproxy_minecraft.lua'));
  execFileSync('openssl', ['dhparam', '-out', path.join(dir, 'dhparam'), '1024'], { stdio: 'ignore' });
  execFileSync('openssl', ['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'key.pem'),
    '-x509', '-days', '1', '-out', path.join(dir, 'cert.pem'), '-subj', '/CN=test'], { stdio: 'ignore' });
  fs.writeFileSync(
    path.join(dir, 'fluxapps', 'dummy.pem'),
    fs.readFileSync(path.join(dir, 'cert.pem')) + fs.readFileSync(path.join(dir, 'key.pem')),
  );
  ['400', '403', '408', '500', '502', '503', '504'].forEach((code) => fs.writeFileSync(path.join(dir, 'errors', `${code}.http`), `HTTP/1.0 ${code}\r\n\r\n`));
}

async function main() {
  const { FluxAppSpecV9 } = await specLibs.load();
  const wire = FluxAppSpecV9.fromSubmission(submission).serialize();
  const dep = await specLibs.resolveDeployment(await specLibs.deserialize(wire), null);
  const routeConfigs = buildRouteConfigs(dep, 'schemeapp', ['172.30.0.11:16127', '172.30.0.12:16127'], false, false);
  const cfg = createAppsHaproxyConfig(routeConfigs);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fdm-v9-'));
  const outPath = path.join(dir, 'v9.cfg');
  fs.writeFileSync(outPath, cfg);
  writeAssets(dir);
  process.stdout.write(`rendered all-schemes v9 config -> ${outPath}\n`);

  const args = ['run', '--rm', '-v', `${outPath}:/cfg:ro`,
    '-v', `${path.join(dir, 'haproxy_minecraft.lua')}:/etc/haproxy/haproxy_minecraft.lua:ro`,
    '-v', `${path.join(dir, 'dhparam')}:/etc/haproxy/dhparam:ro`,
    '-v', `${path.join(dir, 'errors')}:/etc/haproxy/errors:ro`,
    '-v', `${path.join(dir, 'fluxapps')}:/etc/ssl/fluxapps:ro`,
    'haproxy:2.9', 'haproxy', '-c', '-f', '/cfg'];
  try {
    execFileSync('docker', args, { encoding: 'utf8', stdio: 'pipe' });
    process.stdout.write('✓ haproxy 2.9 accepts the all-schemes v9 config (tcp SNI router + loopback terminating listener)\n');
    process.exit(0);
  } catch (e) {
    const alerts = ((e.stderr || '') + (e.stdout || '')).split('\n').filter((l) => l.includes('ALERT') || l.includes('parsing')).slice(0, 12);
    process.stdout.write(`✗ haproxy REJECTED the v9 config:\n${alerts.join('\n')}\n`);
    process.exit(1);
  }
}

main().catch((error) => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });

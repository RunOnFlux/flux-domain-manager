// Prove the draining-backend rendering on real haproxy 2.9, in two steps:
//
//   1. a full FDM config carrying draining backends parses (`haproxy -c`);
//   2. at runtime a `disabled` server takes no traffic yet stays visible in the stats
//      as MAINT — which is the whole point of rendering it instead of dropping it.
//
// Step 2 is the one that matters: the unit tests lock the directive text, but only
// haproxy can confirm the directive means what we think it means.
//
// Local/dev only: needs docker + the haproxy:2.9 image.
// Usage (from repo root): node tests/local/live-render-check-drain.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const specLibs = require('../../src/services/flux/specLibs');
const { buildRouteConfigs } = require('../../src/services/haproxy/buildRouteConfigs');
const { looseBackends, looseDeployments } = require('../unit/fixtures/renderPipeline');
const { createAppsHaproxyConfig } = require('../../src/services/haproxyTemplate');

const ACTIVE = ['172.30.0.11:16127', '172.30.0.12:16127'];
const DRAINING = ['172.30.0.13:16127'];

const submission = {
  version: 9,
  name: 'drainapp',
  description: 'drain render check',
  owner: '16dNCFf7nR3nx5iwn2RQMBw6KcJXkE3JC1',
  ttl: 2592000,
  instances: 3,
  contacts: { email: ['a@b.com'] },
  components: {
    web: {
      name: 'web',
      description: 'web',
      image: 'nginx:latest',
      cpu: 0.5,
      memory: 300,
      rootFsGb: 2,
      persistentStorage: { sizeGb: 5 },
      ports: { web: { containerPort: 80, hostPort: 31000 } },
      loadBalancing: { web: { provider: 'haproxy', mode: 'http', customDomains: ['drain.example.com'] } },
    },
  },
};

function writeAssets(dir) {
  fs.mkdirSync(path.join(dir, 'errors'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'fluxapps'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'haproxy_minecraft.lua'), '');
  execFileSync('openssl', ['dhparam', '-out', path.join(dir, 'dhparam'), '1024'], { stdio: 'ignore' });
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2',
    '-subj', '/CN=drain.example.com', '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem')], { stdio: 'ignore' });
  fs.writeFileSync(
    path.join(dir, 'fluxapps', 'drain.pem'),
    fs.readFileSync(path.join(dir, 'c.pem')) + fs.readFileSync(path.join(dir, 'k.pem')),
  );
  ['400', '403', '408', '500', '502', '503', '504'].forEach((code) => fs.writeFileSync(path.join(dir, 'errors', `${code}.http`), `HTTP/1.0 ${code}\r\n\r\n`));
}

// Step 1: the real pipeline output, validated by haproxy's own parser.
function checkParses(dir) {
  const outPath = path.join(dir, 'drain.cfg');
  const args = ['run', '--rm', '-v', `${outPath}:/cfg:ro`,
    '-v', `${path.join(dir, 'haproxy_minecraft.lua')}:/etc/haproxy/haproxy_minecraft.lua:ro`,
    '-v', `${path.join(dir, 'dhparam')}:/etc/haproxy/dhparam:ro`,
    '-v', `${path.join(dir, 'errors')}:/etc/haproxy/errors:ro`,
    '-v', `${path.join(dir, 'fluxapps')}:/etc/ssl/fluxapps:ro`,
    'haproxy:2.9', 'haproxy', '-c', '-f', '/cfg'];
  try {
    execFileSync('docker', args, { encoding: 'utf8', stdio: 'pipe' });
    process.stdout.write('✓ haproxy 2.9 accepts a config carrying draining (disabled) backends\n');
    return true;
  } catch (e) {
    const alerts = ((e.stderr || '') + (e.stdout || '')).split('\n').filter((l) => l.includes('ALERT') || l.includes('parsing')).slice(0, 12);
    process.stdout.write(`✗ haproxy REJECTED the config:\n${alerts.join('\n')}\n`);
    return false;
  }
}

// Step 2: what `disabled` actually does. One reachable server in rotation, one reachable
// server disabled; every request must land on the first, and the second must report MAINT.
function checkRuntimeBehaviour() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fdm-drain-rt-'));
  const cfg = `defaults
  mode http
  timeout connect 5000
  timeout client 30000
  timeout server 30000
frontend f
  bind *:8080
  default_backend b
listen stats_page
  bind *:8081
  stats enable
  stats uri /stats
backend b
  balance roundrobin
  server live 127.0.0.1:9001 check
  server draining 127.0.0.1:9002 check disabled
listen live_backend
  bind 127.0.0.1:9001
  http-request return status 200 content-type text/plain string "LIVE"
listen draining_backend
  bind 127.0.0.1:9002
  http-request return status 200 content-type text/plain string "DRAINING"
`;
  fs.writeFileSync(path.join(dir, 'rt.cfg'), cfg);
  const name = 'fdm-drain-runtime';
  execFileSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
  execFileSync('docker', ['run', '-d', '--name', name, '-p', '18099:8080', '-p', '18098:8081',
    '-v', `${path.join(dir, 'rt.cfg')}:/cfg:ro`, 'haproxy:2.9', 'haproxy', '-f', '/cfg'], { stdio: 'ignore' });
  try {
    execFileSync('sh', ['-c', 'sleep 2']);
    const hits = new Set();
    for (let i = 0; i < 12; i += 1) {
      hits.add(execFileSync('curl', ['-s', '-m', '5', 'http://localhost:18099/'], { encoding: 'utf8' }).trim());
    }
    // The stats page is the operator surface this whole change exists to preserve, so
    // read the server's state the way an operator would rather than via the admin socket.
    const stat = execFileSync('curl', ['-s', '-m', '5', 'http://localhost:18098/stats;csv'], { encoding: 'utf8' });
    const drainingRow = stat.split('\n').find((l) => l.startsWith('b,draining,')) || '';
    const status = drainingRow.split(',')[17];

    const tookNoTraffic = !hits.has('DRAINING') && hits.has('LIVE');
    const visible = Boolean(drainingRow);
    process.stdout.write(`${tookNoTraffic ? '✓' : '✗'} disabled server took no traffic over 12 requests (saw: ${[...hits].join(', ')})\n`);
    process.stdout.write(`${visible ? '✓' : '✗'} disabled server still present in stats, status=${status || '(missing)'}\n`);
    return tookNoTraffic && visible && status === 'MAINT';
  } finally {
    execFileSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
  }
}

async function main() {
  const { FluxAppSpecV9 } = await specLibs.load();
  const wire = FluxAppSpecV9.fromSubmission(submission).serialize();
  const dep = await specLibs.resolveDeployment(await specLibs.deserialize(wire), null);
  const routeConfigs = buildRouteConfigs(looseDeployments(dep), 'drainapp', looseBackends(ACTIVE, DRAINING), false, false);
  const cfg = createAppsHaproxyConfig(routeConfigs);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fdm-drain-'));
  fs.writeFileSync(path.join(dir, 'drain.cfg'), cfg);
  writeAssets(dir);
  process.stdout.write(`rendered config with ${DRAINING.length} draining backend -> ${path.join(dir, 'drain.cfg')}\n`);

  const parses = checkParses(dir);
  const behaves = checkRuntimeBehaviour();
  process.exit(parses && behaves ? 0 : 1);
}

main().catch((error) => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });

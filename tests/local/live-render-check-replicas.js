// Prove co-located replicas on real haproxy 2.9, in two steps:
//
//   1. a full FDM config with two replicas of one app on ONE node parses (`haproxy -c`).
//      This is the case that used to be impossible: both servers were named for the node
//      address, and haproxy rejects a duplicate server name FATALLY — refusing the entire
//      config, i.e. every app's routing, not just the offending one.
//   2. at runtime both co-located servers actually receive traffic, so the two replicas
//      are genuinely addressable and not one shadowing the other.
//
// Local/dev only: needs docker + the haproxy:2.9 image.
// Usage (from repo root): node tests/local/live-render-check-replicas.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const specLibs = require('../../src/services/flux/specLibs');
const { buildRouteConfigs } = require('../../src/services/haproxy/buildRouteConfigs');
const { createAppsHaproxyConfig } = require('../../src/services/haproxyTemplate');

// r1 + r2 co-located on .11, r3 alone on .12. Each replica binds its own host port.
const NODE_A = '172.30.0.11:16127';
const NODE_B = '172.30.0.12:16127';
const BACKENDS = [
  { ip: NODE_A, replica: 'r1', draining: false },
  { ip: NODE_A, replica: 'r2', draining: false },
  { ip: NODE_B, replica: 'r3', draining: false },
];

const submission = {
  version: 9,
  name: 'coloapp',
  description: 'co-located replica render check',
  owner: '16dNCFf7nR3nx5iwn2RQMBw6KcJXkE3JC1',
  ttl: 2592000,
  contacts: { email: ['a@b.com'] },
  assignment: { targetIps: { '172.30.0.11': ['r1', 'r2'], '172.30.0.12': ['r3'] } },
  components: {
    web: {
      name: 'web',
      description: 'web',
      image: 'nginx:latest',
      cpu: 0.5,
      memory: 300,
      rootFsGb: 2,
      persistentStorage: { sizeGb: 5 },
      ports: { http: { containerPort: 80, hostPort: 31000 } },
      loadBalancing: { http: { provider: 'haproxy', mode: 'http', customDomains: ['colo.example.com'] } },
      replicaOverrides: {
        r2: { ports: { http: { hostPort: 31001 } } },
        r3: { ports: { http: { hostPort: 31002 } } },
      },
    },
  },
};

function writeAssets(dir) {
  fs.mkdirSync(path.join(dir, 'errors'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'fluxapps'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'haproxy_minecraft.lua'), '');
  execFileSync('openssl', ['dhparam', '-out', path.join(dir, 'dhparam'), '1024'], { stdio: 'ignore' });
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2',
    '-subj', '/CN=colo.example.com', '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem')], { stdio: 'ignore' });
  fs.writeFileSync(
    path.join(dir, 'fluxapps', 'colo.pem'),
    fs.readFileSync(path.join(dir, 'c.pem')) + fs.readFileSync(path.join(dir, 'k.pem')),
  );
  ['400', '403', '408', '500', '502', '503', '504'].forEach((code) => fs.writeFileSync(path.join(dir, 'errors', `${code}.http`), `HTTP/1.0 ${code}\r\n\r\n`));
}

function checkParses(dir, cfgPath) {
  const args = ['run', '--rm', '-v', `${cfgPath}:/cfg:ro`,
    '-v', `${path.join(dir, 'haproxy_minecraft.lua')}:/etc/haproxy/haproxy_minecraft.lua:ro`,
    '-v', `${path.join(dir, 'dhparam')}:/etc/haproxy/dhparam:ro`,
    '-v', `${path.join(dir, 'errors')}:/etc/haproxy/errors:ro`,
    '-v', `${path.join(dir, 'fluxapps')}:/etc/ssl/fluxapps:ro`,
    'haproxy:2.9', 'haproxy', '-c', '-f', '/cfg'];
  try {
    execFileSync('docker', args, { encoding: 'utf8', stdio: 'pipe' });
    process.stdout.write('✓ haproxy 2.9 accepts a config with two replicas co-located on one node\n');
    return true;
  } catch (e) {
    const alerts = ((e.stderr || '') + (e.stdout || '')).split('\n').filter((l) => l.includes('ALERT') || l.includes('parsing')).slice(0, 12);
    process.stdout.write(`✗ haproxy REJECTED the co-located config:\n${alerts.join('\n')}\n`);
    return false;
  }
}

// Both co-located servers must actually take traffic. Two listeners on ONE loopback
// address, on the two host ports the replicas resolved — the shape the real config has.
function checkRuntimeBehaviour() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fdm-colo-rt-'));
  const cfg = `defaults
  mode http
  timeout connect 5000
  timeout client 30000
  timeout server 30000
frontend f
  bind *:8080
  default_backend b
backend b
  balance roundrobin
  server 127.0.0.1:16127_r1 127.0.0.1:31000 check
  server 127.0.0.1:16127_r2 127.0.0.1:31001 check
listen r1
  bind 127.0.0.1:31000
  http-request return status 200 content-type text/plain string "R1"
listen r2
  bind 127.0.0.1:31001
  http-request return status 200 content-type text/plain string "R2"
`;
  fs.writeFileSync(path.join(dir, 'rt.cfg'), cfg);
  const name = 'fdm-colo-runtime';
  execFileSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
  execFileSync('docker', ['run', '-d', '--name', name, '-p', '18097:8080',
    '-v', `${path.join(dir, 'rt.cfg')}:/cfg:ro`, 'haproxy:2.9', 'haproxy', '-f', '/cfg'], { stdio: 'ignore' });
  try {
    execFileSync('sh', ['-c', 'sleep 2']);
    const hits = new Set();
    for (let i = 0; i < 12; i += 1) {
      hits.add(execFileSync('curl', ['-s', '-m', '5', 'http://localhost:18097/'], { encoding: 'utf8' }).trim());
    }
    const both = hits.has('R1') && hits.has('R2');
    process.stdout.write(`${both ? '✓' : '✗'} both co-located replicas received traffic (saw: ${[...hits].join(', ')})\n`);
    return both;
  } finally {
    execFileSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
  }
}

async function main() {
  const { FluxAppSpecV9 } = await specLibs.load();
  const wire = FluxAppSpecV9.fromSubmission(submission).serialize();
  const instance = await specLibs.deserialize(wire);
  const deployments = new Map([[null, await specLibs.resolveDeployment(instance, null)]]);
  // eslint-disable-next-line no-restricted-syntax
  for (const replica of ['r1', 'r2', 'r3']) {
    // eslint-disable-next-line no-await-in-loop
    deployments.set(replica, await specLibs.resolveDeployment(instance, replica));
  }
  const routeConfigs = buildRouteConfigs(deployments, 'coloapp', BACKENDS, false, false);
  const cfg = createAppsHaproxyConfig(routeConfigs);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fdm-colo-'));
  const cfgPath = path.join(dir, 'colo.cfg');
  fs.writeFileSync(cfgPath, cfg);
  writeAssets(dir);
  process.stdout.write(`rendered co-located replica config -> ${cfgPath}\n`);
  const serverLines = cfg.split('\n').filter((l) => l.trim().startsWith('server ') && l.includes('172.30.0.11'));
  process.stdout.write(`  node .11 server lines:\n${serverLines.map((l) => `    ${l.trim()}`).join('\n')}\n`);

  const parses = checkParses(dir, cfgPath);
  const behaves = checkRuntimeBehaviour();
  process.exit(parses && behaves ? 0 : 1);
}

main().catch((error) => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });

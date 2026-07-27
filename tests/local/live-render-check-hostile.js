/* eslint-disable no-restricted-syntax, no-continue */ // sequential await per payload
// Prove real haproxy 2.9 accepts everything a hostile owner can get past validation.
//
// tests/unit/haproxyInjection.test.js asserts the structural property — a payload that
// survives validation must not add a line. This asserts the other half: whatever DOES
// survive still produces a configuration haproxy will load. Both matter, and they fail
// differently. An injected line is an owner writing our config; a line haproxy rejects is
// a fleet-wide outage, because restartProxy refuses the file and every app on the director
// stops getting routing updates until someone notices.
//
// Every surviving payload is rendered into ONE config so a single haproxy -c covers the
// lot. Local/dev only: needs docker + the haproxy:2.9 image.
// Usage (from repo root): node tests/local/live-render-check-hostile.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { load } = require('@runonflux/flux-spec-cjs');
const specLibs = require('../../src/services/flux/specLibs');
const { buildRouteConfigs } = require('../../src/services/haproxy/buildRouteConfigs');
const { looseBackends, looseDeployments } = require('../unit/fixtures/renderPipeline');
const { createAppsHaproxyConfig } = require('../../src/services/haproxyTemplate');

// Same corpus as the unit test, kept in step by hand deliberately — this file is run by a
// human, and a payload added here should be added there too.
const HOSTILE = [
  ['newline', '\n  http-request deny'],
  ['carriage return', '\r  http-request deny'],
  ['CRLF', '\r\n  http-request deny'],
  ['tab', '\t  http-request deny'],
  ['form feed', '\f  http-request deny'],
  ['vertical tab', '\v  http-request deny'],
  ['NUL', '  http-request deny'],
  ['escape sequence', '\\n  http-request deny'],
  ['hex escape', '\\x0a  http-request deny'],
  ['space', ' http-request deny'],
  ['comment', '# http-request deny'],
  ['double quote', '" http-request deny'],
  ['single quote', "' http-request deny"],
  ['backslash', '\\ http-request deny'],
  ['env sigil', '$PATH'],
  ['env braces', `${String.fromCharCode(36)}{PATH}`],
  ['new section', '\nbackend hijacked\n  server evil 10.6.6.6:1'],
  ['extra server', '\n  server evil 10.6.6.6:1'],
  ['non-ascii', 'é中'],
  ['long', 'a'.repeat(5000)],
  ['leading space', '   value'],
  ['trailing space', 'value   '],
  ['empty', ''],
];

const FIELDS = [
  ['hcPath', (v) => ({ healthCheck: { path: `/health${v}` } })],
  ['hcExpectString', (v) => ({ healthCheck: { path: '/h', expectString: `ok${v}` } })],
  ['hcStatus', (v) => ({ healthCheck: { path: '/h', expectedStatus: `200${v}` } })],
  ['hcMethod', (v) => ({ healthCheck: { path: '/h', method: `GET${v}` } })],
  ['hcInterval', (v) => ({ healthCheck: { path: '/h', interval: `5s${v}` } })],
  ['cookieName', (v) => ({ stickySessions: { cookieName: `SRVID${v}` } })],
  ['balancing', (v) => ({ balancing: `roundrobin${v}` })],
  ['scheme', (v) => ({ scheme: `httpsRedirect${v}` })],
  ['tlsVerify', (v) => ({ backendTls: { verify: `none${v}` } })],
  ['timeoutServer', (v) => ({ timeouts: { server: `30s${v}` } })],
  ['retryOn', (v) => ({ retries: { count: 3, retryOn: [`conn-failure${v}`] } })],
  ['customDomain', (v) => ({ customDomains: [`shop.example.com${v}`] })],
];

// Half-formed blocks: every field the renderer reads must be materialized, or the config
// gets "undefined" and haproxy refuses the file.
const PARTIALS = [
  ['pHealthBare', { healthCheck: {} }],
  ['pHealthPath', { healthCheck: { path: '/health' } }],
  ['pSticky', { stickySessions: {} }],
  ['pTimeouts', { timeouts: { server: '30s' } }],
  ['pRetries', { retries: { count: 2 } }],
  ['pTlsBare', { backendTls: {} }],
  ['pDrain', { drain: {} }],
];

const submission = (name, hostPort, lb) => ({
  version: 9,
  name,
  description: 'x',
  owner: '16dNCFf7nR3nx5iwn2RQMBw6KcJXkE3JC1',
  ttl: 2592000,
  instances: 1,
  contacts: { email: ['a@b.com'] },
  components: {
    web: {
      name: 'web',
      description: 'x',
      image: 'nginx:latest',
      cpu: 0.5,
      memory: 300,
      rootFsGb: 2,
      persistentStorage: { sizeGb: 5 },
      ports: { http: { containerPort: 80, hostPort } },
      loadBalancing: { http: { provider: 'haproxy', mode: 'http', ...lb } },
    },
  },
});

// Borrowed from live-render-check.js: the files haproxy insists exist before it will
// parse a config that references them.
function writeHaproxyAssets(dir) {
  fs.mkdirSync(path.join(dir, 'errors'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'fluxapps'), { recursive: true });
  for (const code of [400, 403, 408, 500, 502, 503, 504]) {
    fs.writeFileSync(
      path.join(dir, 'errors', `${code}.http`),
      `HTTP/1.0 ${code}\r\nCache-Control: no-cache\r\nConnection: close\r\nContent-Type: text/html\r\n\r\n<html><body>${code}</body></html>\r\n`,
    );
  }
  fs.writeFileSync(path.join(dir, 'haproxy_minecraft.lua'), '');
  execFileSync('openssl', ['dhparam', '-out', path.join(dir, 'dhparam'), '1024'], { stdio: 'ignore' });
  const key = path.join(dir, 'k.pem');
  const crt = path.join(dir, 'c.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-keyout', key, '-out', crt,
    '-days', '2', '-nodes', '-subj', '/CN=test'], { stdio: 'ignore' });
  fs.writeFileSync(
    path.join(dir, 'fluxapps', 'test.pem'),
    fs.readFileSync(crt, 'utf8') + fs.readFileSync(key, 'utf8'),
  );
}

async function main() {
  const { FluxAppSpecV9 } = await load();
  const cases = [];
  FIELDS.forEach(([field, build]) => {
    HOSTILE.forEach(([name, payload]) => cases.push([`${field}-${name}`, build(payload)]));
  });
  PARTIALS.forEach(([label, lb]) => cases.push([label, lb]));

  const routeConfigs = [];
  let survived = 0;
  let rejected = 0;
  let hostPort = 31000;
  for (const [label, lb] of cases) {
    const appName = `hostile${label.replace(/[^a-z0-9]/gi, '').toLowerCase()}`;
    hostPort += 1;
    let wire;
    try {
      wire = FluxAppSpecV9.fromSubmission(submission(appName, hostPort, lb)).serialize();
    } catch (e) { rejected += 1; continue; }
    try {
      // eslint-disable-next-line no-await-in-loop
      const dep = await specLibs.resolveDeployment(await specLibs.deserialize(wire), null);
      const backends = looseBackends(['144.76.10.20:16127']);
      routeConfigs.push(...buildRouteConfigs(looseDeployments(dep), appName, backends, false, false));
      survived += 1;
    } catch (e) { rejected += 1; }
  }

  const cfg = createAppsHaproxyConfig(routeConfigs);
  const outPath = path.join(__dirname, 'hostile-render.cfg');
  fs.writeFileSync(outPath, cfg);
  process.stdout.write(`${cases.length} payloads: ${rejected} refused at validation, ${survived} rendered -> ${outPath}\n`);

  if (!survived) {
    process.stdout.write('✗ every payload was refused — this proves nothing about the renderer\n');
    process.exit(1);
  }

  const assets = fs.mkdtempSync(path.join(os.tmpdir(), 'fdm-hostile-'));
  writeHaproxyAssets(assets);
  const args = ['run', '--rm', '-v', `${outPath}:/cfg:ro`,
    '-v', `${path.join(assets, 'haproxy_minecraft.lua')}:/etc/haproxy/haproxy_minecraft.lua:ro`,
    '-v', `${path.join(assets, 'dhparam')}:/etc/haproxy/dhparam:ro`,
    '-v', `${path.join(assets, 'errors')}:/etc/haproxy/errors:ro`,
    '-v', `${path.join(assets, 'fluxapps')}:/etc/ssl/fluxapps:ro`,
    'haproxy:2.9', 'haproxy', '-c', '-f', '/cfg'];
  try {
    execFileSync('docker', args, { encoding: 'utf8', stdio: 'pipe' });
    process.stdout.write('✓ haproxy 2.9 accepts every rendered survivor\n');
    process.exit(0);
  } catch (e) {
    const alerts = ((e.stderr || '') + (e.stdout || '')).split('\n').filter((l) => l.includes('ALERT')).slice(0, 10);
    process.stdout.write(`✗ haproxy REJECTED the config — a surviving payload is a fleet-wide outage:\n${alerts.join('\n')}\n`);
    process.exit(1);
  }
}

main().catch((error) => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });

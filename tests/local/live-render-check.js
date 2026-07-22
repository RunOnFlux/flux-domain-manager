// Render the full haproxy config over the live app population using each app's REAL
// location IPs (not the fixed IPs of sweep.js), then validate it against real
// haproxy 2.9. This exercises the multi-IP cookie/backup/sort branches at production
// scale (apps with up to ~100 backends, varied api ports, zero-location apps) and
// proves the rewritten renderer emits a config haproxy actually accepts. Local/dev
// only: needs docker + the haproxy:2.9 image.
//
// Requires tests/local/corpus-raw.json + tests/local/locations.json — pull with:
//   curl -s https://api.runonflux.io/apps/globalappsspecifications > tests/local/corpus-raw.json
//   curl -s https://api.runonflux.io/apps/locations              > tests/local/locations.json
//
// Usage (from repo root): node tests/local/live-render-check.js
/* eslint-disable no-restricted-syntax, no-continue, no-await-in-loop */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { buildRouteConfigs } = require('../../src/services/haproxy/buildRouteConfigs');
const { createAppsHaproxyConfig } = require('../../src/services/haproxyTemplate');
const specLibs = require('../../src/services/flux/specLibs');
const serviceHelper = require('../../src/services/serviceHelper');

function markerPresent(spec, marker) {
  const datas = spec.version <= 3 ? [spec.containerData] : (spec.compose || []).map((c) => c.containerData || '');
  return datas.some((d) => typeof d === 'string' && d.includes(marker));
}

// Assemble the haproxy asset files the config references so `haproxy -c` gets past
// file checks to real config validation. The minecraft lua is the repo's real one
// (it registers the actions the tcp frontends call); the cert/dhparam/error files are
// throwaway stand-ins — their contents don't affect config validity.
function writeHaproxyAssets(dir) {
  fs.mkdirSync(path.join(dir, 'errors'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'fluxapps'), { recursive: true });
  fs.copyFileSync(path.join(__dirname, '../../deployment/haproxy_minecraft.lua'), path.join(dir, 'haproxy_minecraft.lua'));
  execFileSync('openssl', ['dhparam', '-out', path.join(dir, 'dhparam'), '1024'], { stdio: 'ignore' });
  execFileSync('openssl', ['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'key.pem'),
    '-x509', '-days', '1', '-out', path.join(dir, 'cert.pem'), '-subj', '/CN=test'], { stdio: 'ignore' });
  const pem = fs.readFileSync(path.join(dir, 'cert.pem')) + fs.readFileSync(path.join(dir, 'key.pem'));
  fs.writeFileSync(path.join(dir, 'fluxapps', 'dummy.pem'), pem);
  ['400', '403', '408', '500', '502', '503', '504'].forEach((code) => {
    fs.writeFileSync(path.join(dir, 'errors', `${code}.http`), `HTTP/1.0 ${code}\r\nContent-Type: text/html\r\n\r\n<html></html>\r\n`);
  });
}

async function main() {
  const corpus = JSON.parse(fs.readFileSync(path.join(__dirname, 'corpus-raw.json'), 'utf8')).data;
  const locations = JSON.parse(fs.readFileSync(path.join(__dirname, 'locations.json'), 'utf8')).data;
  const byApp = {};
  locations.forEach((r) => { (byApp[r.name] = byApp[r.name] || []).push(r.ip); });

  const general = []; const single = [];
  let rendered = 0; let sealed = 0; let noLoc = 0; let maxIps = 0;
  for (const spec of corpus) {
    let inst;
    try { inst = await specLibs.deserialize(spec); } catch { continue; }
    if (inst.sealed) { sealed += 1; continue; }
    const activeStandby = markerPresent(spec, 'g:');
    const appIps = [...(byApp[spec.name] || [])];
    serviceHelper.sortIPAddresses(appIps);
    if (!appIps.length) noLoc += 1;
    maxIps = Math.max(maxIps, appIps.length);
    const dep = await specLibs.resolveDeployment(inst, null);
    const routeConfigs = buildRouteConfigs(dep, spec.name, appIps, activeStandby, markerPresent(spec, 'r:'));
    (activeStandby ? single : general).push(...routeConfigs);
    rendered += 1;
  }
  const cfg = createAppsHaproxyConfig(general.concat(single));
  const outPath = path.join(__dirname, 'live-render.cfg');
  fs.writeFileSync(outPath, cfg);
  process.stdout.write(`rendered ${rendered} apps (sealed ${sealed}, ${noLoc} without locations, max ${maxIps} backends) -> ${outPath}\n`);

  const assets = fs.mkdtempSync(path.join(os.tmpdir(), 'fdm-hap-'));
  writeHaproxyAssets(assets);
  const args = ['run', '--rm', '-v', `${outPath}:/cfg:ro`,
    '-v', `${path.join(assets, 'haproxy_minecraft.lua')}:/etc/haproxy/haproxy_minecraft.lua:ro`,
    '-v', `${path.join(assets, 'dhparam')}:/etc/haproxy/dhparam:ro`,
    '-v', `${path.join(assets, 'errors')}:/etc/haproxy/errors:ro`,
    '-v', `${path.join(assets, 'fluxapps')}:/etc/ssl/fluxapps:ro`,
    'haproxy:2.9', 'haproxy', '-c', '-f', '/cfg'];
  try {
    execFileSync('docker', args, { encoding: 'utf8', stdio: 'pipe' });
    // exit 0 = valid; haproxy still prints environmental warnings to stderr (the
    // throwaway cert's DH params, the missing runtime server-state file) — expected.
    process.stdout.write('✓ haproxy 2.9 accepts the live config (valid; environmental warnings only)\n');
    process.exit(0);
  } catch (e) {
    const alerts = ((e.stderr || '') + (e.stdout || '')).split('\n').filter((l) => l.includes('ALERT')).slice(0, 10);
    process.stdout.write(`✗ haproxy REJECTED the live config:\n${alerts.join('\n')}\n`);
    process.exit(1);
  }
}

main().catch((error) => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });

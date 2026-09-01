/**
 * Before/after benchmark for the FluxOS domain-manager G selection pass.
 *
 * The "before" implementation is not a re-description of the loop - it is the
 * committed code, required from whatever checkout --impl-root points at. When
 * that checkout exports selectGPrimaries the benchmark drives it; when it does
 * not, it drives the serial per-app loop that domainService.js:1002-1030 runs
 * today. So `--impl-root <old worktree>` measures the real old pass.
 *
 * Usage:
 *   node poc/bench.js --impl-root=/path/to/checkout --apps=336 --nodes=200 \
 *                     --fleet-host=127.0.0.1 --port-base=20000
 */
const path = require('path');
const http = require('http');
const scenario = require('./scenario');

function arg(name, dflt) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : dflt;
}

const IMPL_ROOT = arg('impl-root', path.resolve(__dirname, '..'));
const APPS = Number(arg('apps', 336));
const NODES = Number(arg('nodes', 200));
const HOST = arg('fleet-host', '127.0.0.1');
const PORT_BASE = Number(arg('port-base', 20000));
const LABEL = arg('label', IMPL_ROOT);

function post(pathname, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      host: HOST,
      port: PORT_BASE - 1,
      path: pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, (res) => {
      let raw = ''; res.on('data', (c) => { raw += c; }); res.on('end', () => resolve(JSON.parse(raw || '{}')));
    });
    req.on('error', reject); req.end(data);
  });
}

function get(pathname) {
  return new Promise((resolve, reject) => {
    http.get({ host: HOST, port: PORT_BASE - 1, path: pathname }, (res) => {
      let raw = ''; res.on('data', (c) => { raw += c; }); res.on('end', () => resolve(JSON.parse(raw || '{}')));
    }).on('error', reject);
  });
}

async function main() {
  // Dynamic by design: --impl-root selects WHICH checkout is measured, so the
  // "before" side is the committed code rather than a copy of it kept in step by
  // hand. Both airbnb rules assume a fixed dependency graph, which is the one
  // thing this file must not have.
  // eslint-disable-next-line import/no-dynamic-require, global-require
  const domainService = require(path.join(IMPL_ROOT, 'src/services/domainService.js'));
  const {
    selectIPforG, setGStickyState, resetGStickyState, selectGPrimaries, monotonicMs,
  } = domainService;

  const sc = scenario.build(APPS, NODES, HOST, PORT_BASE);
  await post('/scenario', { placements: sc.placements });

  // Warm steady state: the healthy apps already have a remembered primary, which
  // is what production is doing on every pass after the first.
  for (const app of sc.apps) resetGStickyState(app.name);
  // The module compares this against its MONOTONIC clock, so a wall-clock value
  // reads as roughly 1.79e12 ms in the past - inside every window - and leaves
  // the 90s grace permanently open, so the sweep-after-primary-fails path could
  // never be exercised.
  const now = typeof monotonicMs === 'function' ? monotonicMs() : Date.now();
  for (const [name, ip] of sc.stickies) setGStickyState(name, ip, now);

  await get('/probes/reset');
  const mode = typeof selectGPrimaries === 'function' ? 'concurrent' : 'serial';
  const started = process.hrtime.bigint();

  let resolved = 0;
  const failed = [];
  if (mode === 'concurrent') {
    const picked = await selectGPrimaries(sc.apps, sc.locations);
    for (const [name, ip] of picked) { if (ip) resolved += 1; else failed.push(name); }
  } else {
    // Verbatim shape of the current G loop body (domainService.js:1002-1030).
    for (const app of sc.apps) {
      const locationIps = sc.locations.get(app.name) || [];
      if (locationIps.length > 0) {
        // eslint-disable-next-line no-await-in-loop
        const selectedIP = await selectIPforG(locationIps, app);
        if (selectedIP) resolved += 1; else failed.push(app.name);
      }
    }
  }

  const elapsedS = Number(process.hrtime.bigint() - started) / 1e9;
  const { served } = await get('/probes');

  console.log(JSON.stringify({
    label: LABEL,
    mode,
    apps: APPS,
    nodes: NODES,
    deadEnding: sc.deadCount,
    resolved,
    elapsedS: Math.round(elapsedS * 100) / 100,
    httpProbes: served,
    perAppMs: Math.round((elapsedS * 1000) / APPS),
    distinctNodes: new Set([...sc.locations.values()].flat()).size,
    unexpectedFailures: failed.filter((n) => Number(n.replace('gapp', '')) >= sc.deadCount),
  }));
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });

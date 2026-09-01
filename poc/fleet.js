/**
 * A synthetic FluxOS fleet for the G-pass benchmark.
 *
 * One process binds many ports; each port is one node. That is equivalent to
 * distinct IPs for what this measures - a real TCP connect, a real HTTP
 * round trip and a real JSON parse per probe - and it lets a 10k-app fleet run
 * on a laptop.
 *
 * Serves the two endpoints the G selection asks about:
 *   GET /apps/listrunningapps -> { status, data: [{ Names: ['/fluxfoo_bar'] }] }
 *   GET /apps/heldcomponents  -> { status, data: ['fluxfoo_bar'] }
 *
 * Latency is modelled on fdm-eu-1-03, 2026-09-01: 14 direct probes of the nodes
 * the production pass was retrying came back 0.06s - 0.55s, and the median
 * per-app time across 336 apps was 0.21s (one sticky probe). So: a 60ms floor
 * with a long thin tail to ~550ms.
 */
const http = require('http');

const PORT_BASE = Number(process.env.FLEET_PORT_BASE || 20000);
const NODE_COUNT = Number(process.env.FLEET_NODES || 200);
const LAT_MIN_MS = Number(process.env.FLEET_LAT_MIN_MS || 60);
const LAT_MAX_MS = Number(process.env.FLEET_LAT_MAX_MS || 550);

// node index -> Set of docker names it is running
const running = new Map();
// node index -> Set of docker names it holds but is not running
const held = new Map();

let served = 0;

function latency() {
  // Most probes near the floor, a thin tail out to LAT_MAX_MS.
  const r = Math.random();
  const spread = (LAT_MAX_MS - LAT_MIN_MS) * (r ** 3);
  return LAT_MIN_MS + spread;
}

function bodyFor(idx, url) {
  if (url.startsWith('/apps/heldcomponents')) {
    return { status: 'success', data: [...(held.get(idx) || [])] };
  }
  return {
    status: 'success',
    data: [...(running.get(idx) || [])].map((name) => ({ Names: [`/${name}`] })),
  };
}

function makeServer(idx) {
  return http.createServer((req, res) => {
    served += 1;
    const payload = JSON.stringify(bodyFor(idx, req.url));
    setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(payload);
    }, latency());
  });
}

// A control port so the benchmark can load a scenario and read the probe count
// without restarting the fleet.
function controlServer() {
  return http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/scenario') {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        const { placements } = JSON.parse(raw);
        running.clear();
        held.clear();
        for (const [idxStr, spec] of Object.entries(placements)) {
          const idx = Number(idxStr);
          running.set(idx, new Set(spec.running || []));
          held.set(idx, new Set(spec.held || []));
        }
        served = 0;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'success', nodes: running.size }));
      });
      return;
    }
    if (req.url === '/probes') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ served }));
      return;
    }
    if (req.url === '/probes/reset') {
      served = 0;
      res.writeHead(200).end('{}');
      return;
    }
    res.writeHead(404).end('{}');
  });
}

async function main() {
  const servers = [];
  for (let i = 0; i < NODE_COUNT; i += 1) {
    const s = makeServer(i);
    s.listen(PORT_BASE + i, '0.0.0.0');
    s.on('error', (e) => { console.error(`node ${i} port ${PORT_BASE + i}: ${e.message}`); });
    servers.push(s);
  }
  controlServer().listen(PORT_BASE - 1, '0.0.0.0');
  console.log(`fleet up: ${NODE_COUNT} nodes on ${PORT_BASE}..${PORT_BASE + NODE_COUNT - 1}, control on ${PORT_BASE - 1}`);
}

main();

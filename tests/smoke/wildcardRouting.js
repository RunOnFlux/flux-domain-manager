/* eslint-disable no-restricted-syntax, no-await-in-loop */
// Disposable, local-only integration test of the generated HAProxy rules.
// Requires Linux host networking, Docker and OpenSSL; no Flux, DNS, Cloudflare or production certs.
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const { execFileSync, spawn } = require('child_process');
const { certificateFingerprint, getServableWildcardRoutes } = require('../../src/services/application/wildcard');
const { createAppsHaproxyConfig } = require('../../src/services/haproxyTemplate');

const routes = [{ domain: 'drop.runonflux.io', targetDomain: 'drop.app.runonflux.io' }];
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fdm-wildcard-'));
const name = `fdm-wildcard-${process.pid}`;
const image = process.env.FDM_TEST_HAPROXY_IMAGE || 'haproxy:3.2-alpine';
const servers = [];
let container;

async function listen(server, host = '127.0.0.1') {
  servers.push(server);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, resolve);
  });
  return server.address().port;
}

async function unusedPort() {
  const server = http.createServer();
  const port = await listen(server);
  await new Promise((resolve) => { server.close(resolve); });
  return port;
}

function app(port, extra = {}) {
  return {
    name: 'drop',
    appName: 'drop_web_31512',
    domain: 'drop.app.runonflux.io',
    port,
    ips: ['127.0.0.1:16127', '127.0.0.2:16127'],
    mode: 'http',
    ssl: false,
    check: true,
    headers: false,
    healthcheck: [],
    serverConfig: '',
    loadBalance: false,
    ...extra,
  };
}

function request(port, host, url = '/', secure = false, method = 'GET', body) {
  return new Promise((resolve, reject) => {
    const req = (secure ? https : http).request({
      hostname: '127.0.0.1',
      port,
      path: url,
      method,
      headers: { Host: host },
      ...(secure ? { servername: host.split(':')[0], ca: fs.readFileSync(path.join(directory, 'certificate.pem')) } : {}),
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: text }));
    });
    req.on('error', reject);
    req.setTimeout(3000, () => req.destroy(new Error('HAProxy request timed out')));
    req.end(body);
  });
}

async function main() {
  const echo = (req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        host: req.headers.host, url: req.url, method: req.method, body, instance: req.socket.localAddress,
      }));
    });
  };
  const backendPort = await listen(http.createServer(echo), '0.0.0.0');
  const ipv6Port = await listen(http.createServer(echo), '::1');
  const httpPort = await unusedPort();
  const httpsPort = await unusedPort();
  fs.mkdirSync(path.join(directory, 'certs'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-keyout', path.join(directory, 'key.pem'), '-out', path.join(directory, 'certificate.pem'),
    '-subj', '/CN=*.drop.runonflux.io', '-addext', 'subjectAltName=DNS:*.drop.runonflux.io,DNS:drop.app.runonflux.io,DNS:ipv6.example.com'], { stdio: 'pipe' });
  fs.writeFileSync(path.join(directory, 'certs', 'drop.runonflux.io.pem'), Buffer.concat([
    fs.readFileSync(path.join(directory, 'certificate.pem')), fs.readFileSync(path.join(directory, 'key.pem')),
  ]));

  const attacker = app(backendPort, { name: 'impostor', appName: 'impostor', domain: 'hello.drop.runonflux.io' });
  const ipv6 = app(ipv6Port, {
    name: 'ipv6', appName: 'ipv6', domain: 'ipv6.example.com', ips: ['[::1]:16127'],
  });
  // A second namespace without a local certificate must remain dormant.
  const bindings = [...routes, { domain: 'offline.example.com', targetDomain: 'missing.app.runonflux.io' }];
  const servable = await getServableWildcardRoutes(bindings, (domain) => certificateFingerprint(domain, Date.now(), path.join(directory, 'certs')));
  assert.equal(servable.length, 1, 'only the namespace with a matching wildcard PEM should be active');
  const generated = createAppsHaproxyConfig([attacker, app(backendPort), ipv6], servable);
  // Keep the actual frontends, ACLs, backends, health checks and balancing. Only
  // remove host-specific OS paths/users and bind disposable loopback ports.
  const config = generated.split('\n').filter((line) => !/^\s*(lua-load|chroot|user |group |daemon$|log |stats socket|ssl-dh-param-file|server-state-file|load-server-state-from-file|errorfile)/.test(line))
    .join('\n').replace('bind *:80', `bind 127.0.0.1:${httpPort}`)
    .replace(/bind \*:443 ssl crt \S+\//, `bind 127.0.0.1:${httpsPort} ssl crt /test/certs/`);
  fs.writeFileSync(path.join(directory, 'haproxy.cfg'), config);
  const docker = ['--rm', '--network', 'host', '--user', '0', '-v', `${directory}:/test:ro`];
  execFileSync('docker', ['run', ...docker, image, 'haproxy', '-c', '-f', '/test/haproxy.cfg'], { stdio: 'pipe' });
  container = spawn('docker', ['run', ...docker, '--name', name, image, 'haproxy', '-db', '-f', '/test/haproxy.cfg'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '';
  container.stdout.on('data', (chunk) => { logs += chunk; });
  container.stderr.on('data', (chunk) => { logs += chunk; });
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await request(httpsPort, 'hello.drop.runonflux.io', '/', true);
      if (response.status === 200) { ready = true; break; }
    } catch (error) { /* Wait for the disposable listener and health checks. */ }
    await new Promise((resolve) => { setTimeout(resolve, 100); });
  }
  assert.ok(ready, `HAProxy did not become ready: ${logs}`);
  const forwarded = await request(httpsPort, 'hello.drop.runonflux.io', '/assets/app.js?version=2', true, 'POST', 'original body');
  assert.equal(forwarded.status, 200);
  const payload = JSON.parse(forwarded.body);
  assert.ok(['127.0.0.1', '127.0.0.2'].includes(payload.instance));
  delete payload.instance;
  assert.deepEqual(payload, {
    host: 'hello.drop.runonflux.io', url: '/assets/app.js?version=2', method: 'POST', body: 'original body',
  });
  const instances = new Set();
  for (let i = 0; i < 6; i += 1) {
    const response = await request(httpsPort, 'hello.drop.runonflux.io', '/', true);
    instances.add(JSON.parse(response.body).instance);
  }
  assert.deepEqual([...instances].sort(), ['127.0.0.1', '127.0.0.2']);
  for (const host of ['HELLO.DROP.RUNONFLUX.IO:443']) {
    const response = await request(httpsPort, host, '/', true);
    assert.equal(response.status, 200);
    assert.equal(JSON.parse(response.body).host, host);
  }
  const redirect = await request(httpPort, 'hello.drop.runonflux.io', '/assets/app.js?q=1');
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.location, 'https://hello.drop.runonflux.io/assets/app.js?q=1');
  assert.equal((await request(httpsPort, 'hello.drop.runonflux.io', '/product/litty-cat-thc-bars-1000mg', true)).status, 403);
  assert.equal((await request(httpsPort, 'drop.app.runonflux.io', '/', true)).status, 200);
  for (const host of ['hello.drop.runonflux.io.attacker.net', 'xdrop.runonflux.io', 'drop.runonflux.io', 'nested.hello.drop.runonflux.io', '-bad.drop.runonflux.io', `${'a'.repeat(64)}.drop.runonflux.io`]) {
    // Check routing independently of whether the one-label TLS cert covers it.
    const response = await new Promise((resolve, reject) => {
      const req = https.get({
        hostname: '127.0.0.1', port: httpsPort, rejectUnauthorized: false, headers: { Host: host },
      }, (res) => {
        res.resume(); res.on('end', () => resolve(res.statusCode));
      });
      req.on('error', reject);
    });
    assert.equal(response, host.endsWith('.drop.runonflux.io') ? 200 : 503, host);
  }
  const ipv6Response = await request(httpsPort, 'ipv6.example.com', '/ipv6', true);
  assert.equal(ipv6Response.status, 200);
  assert.equal(JSON.parse(ipv6Response.body).instance, '::1');
  const unavailable = await new Promise((resolve, reject) => {
    const req = https.get({
      hostname: '127.0.0.1', port: httpsPort, rejectUnauthorized: false, headers: { Host: 'site.offline.example.com' },
    }, (res) => {
      res.resume(); res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
  });
  assert.equal(unavailable, 503);
  console.log('PASS: generated HAProxy validates; wildcard TLS, HTTP IPv4/IPv6 upstreams, original Host/path/query/body, balancing, namespace reservation, suffix isolation and missing-target 503, and existing exact-host routing');
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (container) {
    try { execFileSync('docker', ['rm', '-f', name], { stdio: 'pipe' }); } catch (error) { /* Already exited. */ }
  }
  await Promise.all(servers.filter((server) => server.listening).map((server) => new Promise((resolve) => { server.close(resolve); })));
  fs.rmSync(directory, { recursive: true, force: true });
});

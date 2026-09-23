/* eslint-disable func-names */
const chai = require('chai');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { FdmDataFetcher } = require('../src/services/flux/dataFetcher');

const { expect } = chai;

function specs(count) {
  return Array.from({ length: count }, (_, i) => ({
    name: `app${i}`,
    version: 3,
    containerData: '/data',
    ports: [],
    domains: [],
  }));
}

// Serves /apps/globalappsspecifications the way api.runonflux.io does, with the
// body and etag set by the test.
async function serveSpecs() {
  const state = { body: null, etag: null };
  const server = http.createServer((req, res) => {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'max-age=30',
      ETag: state.etag,
      fluxnode: 'server17_65.109.53.19',
    });
    res.end(JSON.stringify(state.body));
  });
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const serve = (body, etag) => { state.body = body; state.etag = etag; };
  return { server, serve, port: server.address().port };
}

// The decrypt client reads its TLS files at construction and parses them only
// when it connects, which these tests never do.
const tlsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fdm-spec-guard-'));
['key', 'cert', 'ca'].forEach((name) => fs.writeFileSync(path.join(tlsDir, name), 'placeholder'));

function newFetcher(port) {
  return new FdmDataFetcher({
    keyPath: path.join(tlsDir, 'key'),
    certPath: path.join(tlsDir, 'cert'),
    caPath: path.join(tlsDir, 'ca'),
    fluxApiBaseUrl: `http://127.0.0.1:${port}/`,
    sasApiBaseUrl: 'https://127.0.0.1:1/',
  });
}

describe('spec-list guard', () => {
  let api;
  let fetcher;
  let updates;

  beforeEach(async () => {
    api = await serveSpecs();
    fetcher = newFetcher(api.port);
    updates = [];
    fetcher.on('appSpecsUpdated', (update) => updates.push(update));

    api.serve({ status: 'success', data: specs(20) }, 'W/"a-20"');
    await fetcher.getAndProcessAppSpecs();
  });

  afterEach(() => { api.server.close(); });

  after(() => { fs.rmSync(tlsDir, { recursive: true, force: true }); });

  it('accepts a normal list and publishes it', () => {
    expect(updates).to.have.lengthOf(1);
    expect(updates[0].nonGApps.size).to.equal(20);
    expect(fetcher.endpoints.globalAppSpecs.etag).to.equal('W/"a-20"');
  });

  it('refuses the empty registry: nothing published, etag kept, retried at the default interval', async () => {
    api.serve({ status: 'success', data: [] }, 'W/"1e-empty"');
    const nextMs = await fetcher.getAndProcessAppSpecs();

    expect(nextMs).to.equal(fetcher.endpoints.globalAppSpecs.defaultFetchMs);
    expect(updates).to.have.lengthOf(1);
    expect(fetcher.endpoints.globalAppSpecs.etag).to.equal('W/"a-20"');
  });

  it('refuses a payload that is not a list', async () => {
    api.serve({ status: 'error', data: { message: 'db not ready' } }, 'W/"x-err"');
    await fetcher.getAndProcessAppSpecs();
    expect(updates).to.have.lengthOf(1);
  });

  it('refuses a drop of more than 30% and accepts one within it', async () => {
    api.serve({ status: 'success', data: specs(13) }, 'W/"a-13"');
    await fetcher.getAndProcessAppSpecs();
    expect(updates).to.have.lengthOf(1);

    api.serve({ status: 'success', data: specs(18) }, 'W/"a-18"');
    await fetcher.getAndProcessAppSpecs();
    expect(updates).to.have.lengthOf(2);
    expect(updates[1].nonGApps.size).to.equal(18);
  });

  it('refuses a first list below the floor', async () => {
    const fresh = newFetcher(api.port);
    const freshUpdates = [];
    fresh.on('appSpecsUpdated', (update) => freshUpdates.push(update));
    api.serve({ status: 'success', data: specs(9) }, 'W/"a-9"');
    await fresh.getAndProcessAppSpecs();
    expect(freshUpdates).to.have.lengthOf(0);
  });
});

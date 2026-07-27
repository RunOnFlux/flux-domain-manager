// Ingestion deserializes every spec through flux-spec and classifies it by its
// resolved shape, for every version alike — so a v9 app flows into the same maps
// as legacy apps, not a special bucket. A spec this node can't read (a malformed
// shape deserialize rejects) must be skipped, not abort ingestion of the rest, and
// must never escape as an unhandled rejection that crash-loops the process.
const chai = require('chai');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { FdmDataFetcher } = require('../../src/services/flux/dataFetcher');
const specLibs = require('../../src/services/flux/specLibs');
const serviceHelper = require('../../src/services/serviceHelper');

const { expect } = chai;

// A real, deserializable cleartext legacy spec from the committed fixtures.
const fixtures = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'characterization-specs.json'), 'utf8'));
const legacyApp = fixtures.find((s) => s.version <= 8 && !s.enterprise && Array.isArray(s.compose));

// The constructor readFileSyncs the cert paths, but the TLS agent is never used on
// the cleartext path this test exercises, so stub files suffice.
function stubCerts() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fdm-guard-'));
  const write = (n) => { const f = path.join(dir, n); fs.writeFileSync(f, 'stub'); return f; };
  return { keyPath: write('key'), certPath: write('cert'), caPath: write('ca') };
}

describe('ingestion — version-blind classification + crash guard', () => {
  let v9Doc;

  before(async () => {
    const { FluxAppSpecV9 } = await specLibs.load();
    v9Doc = FluxAppSpecV9.fromSubmission({
      version: 9,
      name: 'shopv9',
      description: 'x',
      owner: '16dNCFf7nR3nx5iwn2RQMBw6KcJXkE3JC1',
      ttl: 2592000,
      contacts: { email: ['a@b.com'] },
      instances: 1,
      components: {
        web: {
          name: 'web',
          description: 'x',
          image: 'nginx:latest',
          cpu: 0.5,
          memory: 300,
          rootFsGb: 2,
          persistentStorage: { sizeGb: 10, mounts: { '/data': { source: 'data', destination: '/data' } } },
          ports: { http: { containerPort: 80, hostPort: 31000 } },
          loadBalancing: { http: { provider: 'haproxy', mode: 'http' } },
        },
      },
    }).serialize();
  });

  it('classifies legacy and v9 into the same maps and skips an unreadable spec', async () => {
    const fetcher = new FdmDataFetcher({
      ...stubCerts(),
      fluxApiBaseUrl: 'http://localhost',
      cryptoService: {
        baseUrl: 'http://localhost', rsaDecryptPath: 'decryptMessageRSA', gcmDecryptPath: 'v2/decrypt', caCertificatePath: 'v2/caCertificate',
      },
    });

    // Missing required fields — deserialize rejects it.
    const malformed = {
      version: 9,
      name: 'malformedv9',
      owner: 'x',
      components: { web: { ports: { http: {} } } },
    };

    const events = [];
    fetcher.on('appSpecsUpdated', (e) => events.push(e));

    await fetcher.processAppSpecs([legacyApp, v9Doc, malformed]); // must resolve, not throw

    expect(events).to.have.lengthOf(1);
    const classified = serviceHelper.concatIterables(
      events[0].activeStandbyApps.keys(),
      events[0].activeActiveApps.keys(),
    );
    expect(classified).to.include(legacyApp.name); // legacy readable spec classified
    expect(classified).to.include('shopv9'); // v9 flows into the same maps, not skipped
    expect(classified).to.not.include('malformedv9'); // unreadable spec skipped, batch survived
  });
});

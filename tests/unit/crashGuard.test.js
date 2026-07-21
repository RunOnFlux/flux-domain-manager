/* eslint-disable func-names */
// A spec FDM can't read (e.g. a v9 shape that today's #isActiveStandby chokes on,
// since it has no `compose`) must be skipped, not abort ingestion of every other
// app — and must never escape as an unhandled rejection that crash-loops the process.
const chai = require('chai');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { FdmDataFetcher } = require('../../src/services/flux/dataFetcher');
const serviceHelper = require('../../src/services/serviceHelper');

const { expect } = chai;

// The constructor readFileSyncs the cert paths, but the TLS agent is never used on
// the cleartext path this test exercises, so stub files suffice.
function stubCerts() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fdm-guard-'));
  const write = (n) => { const f = path.join(dir, n); fs.writeFileSync(f, 'stub'); return f; };
  return { keyPath: write('key'), certPath: write('cert'), caPath: write('ca') };
}

describe('ingestion crash guard', function () {
  it('skips a spec that throws instead of aborting the batch', async function () {
    const fetcher = new FdmDataFetcher({
      ...stubCerts(), fluxApiBaseUrl: 'http://localhost', sasApiBaseUrl: 'http://localhost',
    });

    const goodV8 = {
      version: 8, name: 'goodv8', owner: 'x',
      compose: [{ name: 'c', containerData: '', ports: [8080], domains: [''] }],
    };
    // v9 has `components`, not `compose` — #isActiveStandby does spec.compose.some(...) -> throws.
    const badV9 = { version: 9, name: 'badv9', owner: 'x', components: { web: { ports: { http: {} } } } };

    const events = [];
    fetcher.on('appSpecsUpdated', (e) => events.push(e));

    await fetcher.processAppSpecs([goodV8, badV9]); // must resolve, not throw

    expect(events).to.have.lengthOf(1);
    const names = serviceHelper.concatIterables(events[0].activeStandbyApps.keys(), events[0].activeActiveApps.keys());
    expect(names).to.include('goodv8'); // readable spec processed
    expect(names).to.not.include('badv9'); // unreadable spec skipped, batch survived
  });
});

// A 200 from the platform API does not guarantee a payload. #parseAxiosResponse returns
// a response object carrying `payload: null` for an empty body, a body whose own status
// is not `success`, and empty data — all on a 200. Guarding only the response object let
// that null reach the processing step, where iterating it threw.
//
// On the deployed build that was fatal: its fetch loop awaited the runner with no catch,
// so the rejection went unhandled and the process exited. The dev director restarted 1093
// times. The loop here catches (bab6fac), so it would survive — but it would still throw,
// log an error and lose the poll on every such response, and would still have advanced
// the stored SHA to the hash of `null` before throwing.
const { expect } = require('chai');
const { FdmDataFetcher } = require('../../src/services/flux/dataFetcher');

// The constructor reads mTLS material off disk, which a test host does not have. Only the
// fetch-and-dispatch methods are under test and they touch `endpoints` and their own HTTP
// getter, so the instance is built without running it.
function fetcherWith(endpoints) {
  const fetcher = Object.create(FdmDataFetcher.prototype);
  fetcher.endpoints = endpoints;
  return fetcher;
}

const emptyResponse = {
  payload: null, etag: 'etag', maxAgeMs: 5_000, backend: 'node1',
};

describe('a 200 carrying no payload is nothing to process', () => {
  it('does not process app specs, and sleeps for the default interval', async () => {
    const endpoints = { globalAppSpecs: { name: 'globalAppSpecs', defaultFetchMs: 30_000, sha: 'previous-sha' } };
    const fetcher = fetcherWith(endpoints);
    let processed = false;
    fetcher.doAppSpecsHttpGet = async () => emptyResponse;
    fetcher.processAppSpecs = async () => { processed = true; };

    const ms = await fetcher.getAndProcessAppSpecs();

    expect(processed).to.equal(false);
    expect(ms).to.equal(30_000);
  });

  // The SHA is the change-detection cache. Advancing it to the hash of `null` would make
  // the next genuinely unchanged payload look like a change.
  it('leaves the stored SHA alone', async () => {
    const endpoints = { globalAppSpecs: { name: 'globalAppSpecs', defaultFetchMs: 30_000, sha: 'previous-sha' } };
    const fetcher = fetcherWith(endpoints);
    fetcher.doAppSpecsHttpGet = async () => emptyResponse;
    fetcher.processAppSpecs = async () => {};

    await fetcher.getAndProcessAppSpecs();

    expect(endpoints.globalAppSpecs.sha).to.equal('previous-sha');
  });

  it('does not process permanent messages', async () => {
    const endpoints = { permMessages: { name: 'permMessages', defaultFetchMs: 60_000, sha: 'previous-sha' } };
    const fetcher = fetcherWith(endpoints);
    let processed = false;
    fetcher.doPermMessagesHttpGet = async () => emptyResponse;
    fetcher.processPermMessages = async () => { processed = true; };

    const ms = await fetcher.getAndProcessPermMessages();

    expect(processed).to.equal(false);
    expect(ms).to.equal(60_000);
    expect(endpoints.permMessages.sha).to.equal('previous-sha');
  });

  // Locations have no SHA gate at all — the payload went straight to processing, so this
  // is the one that threw on every empty response rather than only on a changed one.
  it('does not process locations', async () => {
    const endpoints = { appsLocations: { name: 'appsLocations', defaultFetchMs: 10_000 } };
    const fetcher = fetcherWith(endpoints);
    let processed = false;
    fetcher.doAppsLocationsHttpGet = async () => emptyResponse;
    fetcher.processAppsLocations = async () => { processed = true; };

    const ms = await fetcher.getAndProcessAppsLocations();

    expect(processed).to.equal(false);
    expect(ms).to.equal(10_000);
  });

  it('returns no specs to the certificate process', async () => {
    const fetcher = fetcherWith({ globalAppSpecs: { name: 'globalAppSpecs', defaultFetchMs: 30_000 } });
    fetcher.doAppSpecsHttpGet = async () => emptyResponse;

    expect(await fetcher.getDecryptedSpecs()).to.deep.equal([]);
  });

  // The guard must not swallow a real payload.
  it('still processes a payload that is present', async () => {
    const endpoints = { globalAppSpecs: { name: 'globalAppSpecs', defaultFetchMs: 30_000, sha: 'previous-sha' } };
    const fetcher = fetcherWith(endpoints);
    let seen = null;
    fetcher.doAppSpecsHttpGet = async () => ({ ...emptyResponse, payload: [{ name: 'anapp' }] });
    fetcher.processAppSpecs = async (specs) => { seen = specs; };

    await fetcher.getAndProcessAppSpecs();

    expect(seen).to.deep.equal([{ name: 'anapp' }]);
    expect(endpoints.globalAppSpecs.sha).to.not.equal('previous-sha');
  });
});

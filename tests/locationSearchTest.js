/* eslint-disable func-names */
const chai = require('chai');
const axios = require('axios');

const { expect } = chai;
const fluxService = require('../src/services/flux');

const { getApplicationLocation } = fluxService;

// The search loops in domainService retry on `answered === false` and stop on
// `true`. That one flag is the whole cost story: every app the bulk feed omits
// replies `success` with zero locations in under 200ms, so a loop that cannot
// tell that from an unreachable API pays five requests where one settles it -
// 35 a pass against 7, for apps that will answer the same way forever.
describe('getApplicationLocation - an empty answer is still an answer', () => {
  const realGet = axios.get;
  afterEach(() => { axios.get = realGet; });

  const stub = (impl) => {
    let calls = 0;
    axios.get = async (...args) => { calls += 1; return impl(...args); };
    return () => calls;
  };

  it('reports ANSWERED when the API says nobody is running the app', async () => {
    stub(async () => ({ data: { status: 'success', data: [] } }));
    const result = await getApplicationLocation('deadapp');
    expect(result.answered).to.equal(true);
    expect(result.locations).to.deep.equal([]);
  });

  it('reports ANSWERED, with the locations, when the API finds instances', async () => {
    const rows = [{ ip: '1.2.3.4:16127' }, { ip: '5.6.7.8:16127' }];
    stub(async () => ({ data: { status: 'success', data: rows } }));
    const result = await getApplicationLocation('liveapp');
    expect(result.answered).to.equal(true);
    expect(result.locations).to.deep.equal(rows);
  });

  // The case the attempts exist for: nothing was settled, so asking again can
  // still produce a different answer.
  it('reports NOT answered when the API could not be reached', async () => {
    stub(async () => { throw new Error('timeout of 3000ms exceeded'); });
    const result = await getApplicationLocation('anyapp');
    expect(result.answered).to.equal(false);
    expect(result.locations).to.deep.equal([]);
  });

  // A 200 carrying an in-band error object. It replied; it did not answer.
  it('reports NOT answered for a 200 whose body says error', async () => {
    stub(async () => ({ data: { status: 'error', data: { message: 'nope' } } }));
    const result = await getApplicationLocation('anyapp');
    expect(result.answered).to.equal(false);
    expect(result.locations).to.deep.equal([]);
  });

  // A missing `data` on a success is not a failure to answer - the API said
  // success, and the caller must not spend four more requests on it.
  it('reports ANSWERED with no locations when a success carries no data', async () => {
    stub(async () => ({ data: { status: 'success' } }));
    const result = await getApplicationLocation('anyapp');
    expect(result.answered).to.equal(true);
    expect(result.locations).to.deep.equal([]);
  });
});

const chai = require('chai');

const { expect } = chai;
const { firstAppPort } = require('../src/services/application/checks');

describe('firstAppPort', () => {
  it('skips a compose component that publishes no ports', () => {
    const explorerb = {
      name: 'explorerb',
      compose: [{ name: 'mongodb', ports: [] }, { name: 'insightfluxexplorer', ports: [38200] }],
    };
    expect(firstAppPort(explorerb)).to.equal(38200);
  });

  it('takes the first port of the first component that has one', () => {
    const app = { name: 'a', compose: [{ ports: [31000, 31001] }, { ports: [32000] }] };
    expect(firstAppPort(app)).to.equal(31000);
  });

  it('reads ports of a pre-compose spec', () => {
    expect(firstAppPort({ name: 'old', ports: ['30001'] })).to.equal('30001');
  });

  it('is undefined when nothing is published', () => {
    expect(firstAppPort({ name: 'none', compose: [{ ports: [] }] })).to.equal(undefined);
  });
});

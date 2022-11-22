/* eslint-disable func-names */
const chai = require('chai');
const appChecks = require('../src/services/application/checks');

const { expect } = chai;

describe('applicationChecks', function () {
  this.timeout(20000);
  it('Tests Ethereum app working correctly', async () => {
    const appOK = await appChecks.checkEthereum('89.58.2.51', 31301);
    const appNotOK = await appChecks.checkEthereum('88.212.61.227', 31301);
    expect(appOK).to.be.equal(true);
    expect(appNotOK).to.be.equal(false);
  });
});

/* eslint-disable func-names */
const chai = require('chai');
const appChecks = require('../../src/services/application/checks');

const { expect } = chai;

describe('applicationChecks', function () {
  this.timeout(20000);
  it('Tests Ethers app check against live node', async () => {
    const result = await appChecks.checkEthers('89.58.2.51', 31301);
    expect(result).to.be.a('boolean');
  });
});

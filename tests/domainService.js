/* eslint-disable func-names */
const chai = require('chai');
const domainService = require('../src/services/domainService');

const { expect } = chai;

describe('domainService', function () {
  this.timeout(20000);
  it('Resolves DNS records ok', async () => {
    const records = await domainService.dnsLookup('www.kdlaunch.com');
    console.log(records);
    expect(records).to.be.an('array');
  });
});

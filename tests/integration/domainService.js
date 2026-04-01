/* eslint-disable func-names */
const chai = require('chai');
const dns = require('dns').promises;

const { expect } = chai;

describe('domainService', function () {
  this.timeout(20000);
  it('Resolves DNS records ok', async () => {
    const records = await dns.lookup('www.kdlaunch.com', { all: true });
    expect(records).to.be.an('array');
    expect(records.length).to.be.greaterThan(0);
    expect(records[0]).to.have.property('address');
    expect(records[0]).to.have.property('family');
  });
});

/* eslint-disable func-names */
const chai = require('chai');
const cloudflareService = require('../src/services/cloudflareService');

const { expect } = chai;

describe('cloudflareService', function () {
  this.timeout(20000);
  it('listCustomHostnames', async () => {
    const records = await cloudflareService.listCustomHostnames();
    console.log(records);
    expect(records).to.be.an('array');
  });
});

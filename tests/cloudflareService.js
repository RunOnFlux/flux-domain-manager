/* eslint-disable func-names */
const chai = require('chai');
const cloudflareService = require('../src/services/cloudflareService');

const { expect } = chai;

describe('cloudflareService', function () {
  this.timeout(20000);
  it('listCustomHostnames', async () => {
    const resp = await cloudflareService.listCustomHostnames('dev.jefke.blog');
    expect(resp.success).to.be.equal(true);
    expect(resp.result).to.be.an('array');
  });
  it('createCustomHostname', async () => {
    const hostname = 'example.nice.com';
    const origin = 'kappa.beta.com';
    const resp = await cloudflareService.createCustomHostname(hostname, origin);
    expect(resp.success).to.be.equal(true);
    expect(resp.result).to.be.an('object');
    expect(resp.result.status).to.be.equal('pending');
    expect(resp.result.ownership_verification_http).to.be.an('object');
    expect(resp.result.hostname).to.be.equal(hostname);
    expect(resp.result.custom_origin_server).to.be.equal(origin);
  });
  it('patchCustomHostname', async () => {
    const hostname = 'example.nice.com';
    const origin = 'new-kappa.beta.com';
    const resp = await cloudflareService.patchCustomHostname(hostname, origin);
    expect(resp.success).to.be.equal(true);
    expect(resp.result).to.be.an('object');
    expect(resp.result.status).to.be.equal('pending');
    expect(resp.result.ownership_verification_http).to.be.an('object');
    expect(resp.result.hostname).to.be.equal(hostname);
    expect(resp.result.custom_origin_server).to.be.equal(origin);
  });
  it('deleteCustomHostname', async () => {
    const hostname = 'example.nice.com';
    const resp = await cloudflareService.deleteCustomHostname(hostname);
    expect(resp.success).to.be.equal(true);
    expect(resp.result).to.be.an('object');
  });
  // unused
  it('getCustomHostname', async () => {
    const resp = await cloudflareService.getCustomHostname('dbed1ab4-c0af-445e-af60-99f781881740');
    expect(resp.success).to.be.equal(true);
    expect(resp.result).to.be.an('object');
  });
});

const { expect } = require('chai');
const { checkDomainAction } = require('../../src/services/domain/cert');
const { getGroupIPs } = require('../../src/services/rsync/config');
const { DOMAIN_TYPE } = require('../../src/services/constants');

// checkDomainAction decides, per domain, whether to obtain, renew or skip. DNS is
// injected so these never touch the network. Certificates are read from /etc/ssl, which
// no test host has, so every domain here is treated as having no certificate yet — the
// branch that leads to issuance.
const resolving = (...addresses) => async () => addresses.map((address) => ({ address, family: 4 }));

// Each test uses its own domain: dnsCache is a module-level singleton and records
// failures across calls.
const long = (n) => `${'a'.repeat(55)}-${n}.example.com`;

describe('checkDomainAction', () => {
  const pointedHere = resolving(getGroupIPs()[0]);
  const pointedElsewhere = resolving('198.51.100.1');

  it('obtains for a domain over 64 characters', async () => {
    const domain = long('over64');
    expect(domain.length).to.be.above(64);
    const result = await checkDomainAction(domain, DOMAIN_TYPE.CUSTOM, null, pointedHere);
    expect(result).to.deep.equal({ domain, action: 'obtain' });
  });

  it('treats a long domain exactly like a short one', async () => {
    const shortDomain = 'short.example.com';
    const shortResult = await checkDomainAction(shortDomain, DOMAIN_TYPE.CUSTOM, null, pointedHere);
    const longResult = await checkDomainAction(long('parity'), DOMAIN_TYPE.CUSTOM, null, pointedHere);
    expect(longResult.action).to.equal(shortResult.action);
  });

  it('skips a domain pointed somewhere else, and says so', async () => {
    const domain = long('elsewhere');
    const result = await checkDomainAction(domain, DOMAIN_TYPE.CUSTOM, null, pointedElsewhere);
    expect(result).to.deep.equal({ domain, action: 'skip', reason: 'dns not pointed' });
  });

  it('gives the excluded domain a reason so it can be counted', async () => {
    const domain = 'ethereumnodelight.app.runonflux.io';
    const result = await checkDomainAction(domain, DOMAIN_TYPE.CUSTOM, null, pointedHere);
    expect(result).to.deep.equal({ domain, action: 'skip', reason: 'excluded' });
  });

  it('never skips without a reason on the paths that reach DNS', async () => {
    const results = await Promise.all([
      checkDomainAction(long('reason1'), DOMAIN_TYPE.CUSTOM, null, pointedElsewhere),
      checkDomainAction(long('reason2'), DOMAIN_TYPE.FDM, null, pointedElsewhere),
    ]);
    results.forEach((r) => {
      expect(r.action).to.equal('skip');
      expect(r.reason).to.be.a('string').and.not.empty;
    });
  });
});

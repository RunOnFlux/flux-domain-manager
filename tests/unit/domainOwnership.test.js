// First-registrant-wins custom-domain ownership. Locks the security behaviour the
// live check had lost (it was a no-op): among the apps that are LIVE right now and
// claim the same domain, the one whose earliest permanent-message registration is
// oldest owns it; the others don't route it. An expired app drops out of the registry
// and can't hold a domain.
const chai = require('chai');
const { DomainOwnershipRegistry } = require('../../src/services/domain/ownership');

const { expect } = chai;

// A permanent message mentioning `domain` for `name` at block `height`.
const msg = (name, domain, height) => ({ appSpecifications: { name, domain }, height });

describe('DomainOwnershipRegistry — first-registrant-wins', () => {
  let registry;
  beforeEach(() => { registry = new DomainOwnershipRegistry(); });

  it('allows a falsy domain (platform FQDNs pass through)', () => {
    expect(registry.ownsDomain('', 'anyapp')).to.equal(true);
    expect(registry.ownsDomain(undefined, 'anyapp')).to.equal(true);
  });

  it('allows an uncontested domain (only one live app claims it)', () => {
    registry.setAppDomains([{ name: 'solo', fqdns: ['solo.example.com'] }]);
    registry.setPermanentMessages([msg('solo', 'solo.example.com', 100)]);
    expect(registry.ownsDomain('solo.example.com', 'solo')).to.equal(true);
  });

  it('awards a contested domain to the older registrant, denies the newer', () => {
    registry.setAppDomains([
      { name: 'light', fqdns: ['api.eth.example.com'] },
      { name: 'snap', fqdns: ['api.eth.example.com'] },
    ]);
    registry.setPermanentMessages([
      msg('light', 'api.eth.example.com', 978907),
      msg('snap', 'api.eth.example.com', 1321066),
    ]);
    expect(registry.ownsDomain('api.eth.example.com', 'light')).to.equal(true);
    expect(registry.ownsDomain('api.eth.example.com', 'snap')).to.equal(false);
  });

  it('is case-insensitive on the domain', () => {
    registry.setAppDomains([
      { name: 'a', fqdns: ['contested.com'] },
      { name: 'b', fqdns: ['contested.com'] },
    ]);
    registry.setPermanentMessages([msg('a', 'contested.com', 1), msg('b', 'contested.com', 2)]);
    expect(registry.ownsDomain('CONTESTED.com', 'b')).to.equal(false);
    expect(registry.ownsDomain('Contested.COM', 'a')).to.equal(true);
  });

  it('does not let an EXPIRED app squat — a gone app leaves the registry, freeing the domain', () => {
    // "newcomer" is the only LIVE claimant, even though an older, now-expired app
    // once registered the domain (its messages linger in the ledger).
    registry.setAppDomains([{ name: 'newcomer', fqdns: ['freed.example.com'] }]);
    registry.setPermanentMessages([
      msg('longgone', 'freed.example.com', 50), // older, but not in appDomains → expired
      msg('newcomer', 'freed.example.com', 900),
    ]);
    expect(registry.ownsDomain('freed.example.com', 'newcomer')).to.equal(true);
  });

  it('fails open when no registration message pins ownership', () => {
    registry.setAppDomains([
      { name: 'x', fqdns: ['orphan.com'] },
      { name: 'y', fqdns: ['orphan.com'] },
    ]);
    registry.setPermanentMessages([]); // contested, but the ledger says nothing
    expect(registry.ownsDomain('orphan.com', 'x')).to.equal(true);
    expect(registry.ownsDomain('orphan.com', 'y')).to.equal(true);
  });
});

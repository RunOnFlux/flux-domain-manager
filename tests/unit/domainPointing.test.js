const { expect } = require('chai');
const { isDomainPointedToThisGroup } = require('../../src/services/domain/cert');
const { getGroupIPs } = require('../../src/services/rsync/config');

// A domain qualifies for a certificate only if it resolves to an address this FDM
// group answers on. The group's addresses come from deployment/hosts.ini; the node's
// own public address is added on top. DNS is injected so these never touch the network.
const resolving = (...addresses) => async () => addresses.map((address) => ({ address, family: 4 }));

describe('isDomainPointedToThisGroup', () => {
  const groupIPs = getGroupIPs();
  const myIP = '203.0.113.7';

  it('accepts a domain resolving to a group address', async () => {
    const pointed = await isDomainPointedToThisGroup('customer.example', myIP, resolving(groupIPs[0]));
    expect(pointed).to.equal(true);
  });

  it('accepts a domain resolving to this node own address', async () => {
    const pointed = await isDomainPointedToThisGroup('customer.example', myIP, resolving(myIP));
    expect(pointed).to.equal(true);
  });

  it('accepts when any one of several addresses matches', async () => {
    const pointed = await isDomainPointedToThisGroup('customer.example', myIP, resolving('198.51.100.1', groupIPs[0]));
    expect(pointed).to.equal(true);
  });

  it('rejects a domain pointed somewhere else', async () => {
    const pointed = await isDomainPointedToThisGroup('customer.example', myIP, resolving('198.51.100.1'));
    expect(pointed).to.equal(false);
  });

  it('rejects a domain that resolves to nothing', async () => {
    const pointed = await isDomainPointedToThisGroup('customer.example', myIP, resolving());
    expect(pointed).to.equal(false);
  });

  it('still matches the group without this node own address', async () => {
    const pointed = await isDomainPointedToThisGroup('customer.example', null, resolving(groupIPs[0]));
    expect(pointed).to.equal(true);
  });

  // The FDM's own hostname used to be added to the comparison set by way of
  // config.domainAppType. It never contributed: the set is compared against A records,
  // which are dotted quads, and the group addresses already cover this node's hostname.
  it('is unaffected by the FDM hostname, which resolves into the group anyway', async () => {
    const pointed = await isDomainPointedToThisGroup('fdm.example', myIP, resolving('fdm-fn-1-1.runonflux.io'));
    expect(pointed).to.equal(false);
  });

  it('returns false rather than throwing when resolution fails', async () => {
    const exploding = async () => { throw new Error('SERVFAIL'); };
    const pointed = await isDomainPointedToThisGroup('customer.example', myIP, exploding);
    expect(pointed).to.equal(false);
  });
});

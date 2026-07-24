// A node address is a socket address, not an IP: IPv4 is bare and IPv6 is bracketed, so
// the port is not whatever follows the first colon. Everything that reads one goes
// through parseSocketAddress, because the alternative silently produces `[2001`.
const { expect } = require('chai');
const config = require('config');
const { parseSocketAddress, unbracket } = require('../../src/services/socketAddress');
const haproxyTemplate = require('../../src/services/haproxyTemplate');

describe('parseSocketAddress', () => {
  it('splits an IPv4 socket address on its port', () => {
    expect(parseSocketAddress('1.2.3.4:16127')).to.deep.equal({ host: '1.2.3.4', port: '16127' });
  });

  it('keeps a bracketed IPv6 host whole', () => {
    expect(parseSocketAddress('[2001:41d0:d00:b800::20]:9130'))
      .to.deep.equal({ host: '[2001:41d0:d00:b800::20]', port: '9130' });
  });

  it('reports no port when the address carries none', () => {
    expect(parseSocketAddress('1.2.3.4')).to.deep.equal({ host: '1.2.3.4', port: null });
    expect(parseSocketAddress('[2001:db8::1]')).to.deep.equal({ host: '[2001:db8::1]', port: null });
  });

  it('strips brackets only where they are a pair', () => {
    expect(unbracket('[2001:db8::1]')).to.equal('2001:db8::1');
    expect(unbracket('1.2.3.4')).to.equal('1.2.3.4');
  });
});

// The configured fixed addresses are the only IPv6 backends FDM renders, and every app
// that has them has two. They differ late in the address, so a name taken from the first
// colon is identical for both, and the second was dropped as a duplicate.
describe('IPv6 backends render as distinct servers', () => {
  const render = (socketAddresses) => {
    const app = {
      name: 'blockbookbitcoin',
      appName: 'blockbookbitcoin_blockbookbitcoin_9130',
      domain: 'blockbookbitcoin_9130.app2.runonflux.io',
      port: 9130,
      ips: socketAddresses,
      syncFirst: false,
      timeout: null,
      servers: socketAddresses.map((ip) => ({
        ip, hostPort: 9130, replica: null, draining: false,
      })),
    };
    return haproxyTemplate.createAppsHaproxyConfig([app])
      .split('\n')
      .filter((line) => line.trim().startsWith('server ') && line.includes('2001:'));
  };

  it('renders one server line per configured address', () => {
    const addresses = config.staticLocations.blockbookbitcoin;
    expect(addresses.length).to.be.above(1);
    expect(render(addresses)).to.have.lengthOf(addresses.length);
  });

  it('gives every configured app of fixed addresses as many servers as it has', () => {
    Object.values(config.staticLocations).forEach((addresses) => {
      expect(render(addresses)).to.have.lengthOf(addresses.length);
    });
  });

  it('still collapses the same address listed twice', () => {
    const [one] = config.staticLocations.blockbookbitcoin;
    expect(render([one, one])).to.have.lengthOf(1);
  });
});

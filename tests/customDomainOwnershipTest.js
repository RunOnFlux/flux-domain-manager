const chai = require('chai');

const { expect } = chai;
const {
  canonicalDomain,
  boundNames,
  specDomains,
  createDomainOwnership,
} = require('../src/services/domain/customDomainOwnership');
const {
  addConfigurations,
  createConfiguredApps,
  domainOwnership,
} = require('../src/services/domainService');

// Shapes as the data fetcher emits them: appFqdns entries from #buildFqdnMap and
// permanent messages from apps/permanentmessages.
const v4Spec = (name, domains) => ({
  name,
  version: 4,
  compose: [{ name: 'web', ports: [30001], domains }],
});
const message = (spec, height) => ({ appSpecifications: spec, height });

function ownershipFor(entries) {
  const ownership = createDomainOwnership();
  ownership.setLiveApps(entries.map(([spec]) => spec));
  ownership.setPermanentMessages(entries.map(([spec, height]) => message(spec, height)));
  return ownership;
}

describe('custom domain ownership', () => {
  describe('canonicalDomain / boundNames', () => {
    it('cuts www. the way addConfigurations does, including mid-label', () => {
      expect(canonicalDomain('https://www.Victim.com')).to.equal('victim.com');
      expect(canonicalDomain('xwww.victim.com')).to.equal('victim.com');
      expect(canonicalDomain(' victim.com ')).to.equal('victim.com');
      expect(canonicalDomain('WWW.victim.com')).to.equal('www.victim.com');
      expect(canonicalDomain('https://https://victim.com')).to.equal('httpsvictim.com');
    });

    it('lists every host a registered domain is served on', () => {
      expect(boundNames('www.victim.com')).to.deep.equal(['victim.com', 'www.victim.com', 'test.victim.com']);
    });

    it('reads v3 and v4 specs and ignores encrypted (enterprise) ones', () => {
      expect(specDomains({ version: 3, ports: [1, 2, 3], domains: ['a.com,b.com', ''] })).to.deep.equal(['a.com', 'b.com', '']);
      expect(specDomains({ version: 3, ports: [1], domains: ['a.com', 'beyond-ports.com'] })).to.deep.equal(['a.com']);
      expect(specDomains(v4Spec('x', ['c.com']))).to.deep.equal(['c.com']);
      expect(specDomains({ version: 8, enterprise: 'base64...', compose: [] })).to.deep.equal([]);
    });
  });

  describe('ownsDomain', () => {
    const victim = v4Spec('victimapp', ['victim.com']);

    it('allows an uncontested domain', () => {
      const ownership = ownershipFor([[victim, 1000]]);
      expect(ownership.ownsDomain('victim.com', 'victimapp')).to.equal(true);
    });

    it('gives a contested domain to the app that registered it first', () => {
      const attacker = v4Spec('zattacker', ['victim.com']);
      const ownership = ownershipFor([[victim, 1000], [attacker, 90000]]);
      expect(ownership.ownsDomain('victim.com', 'victimapp')).to.equal(true);
      expect(ownership.ownsDomain('victim.com', 'zattacker')).to.equal(false);
      expect(ownership.ownsDomain('www.victim.com', 'zattacker')).to.equal(false);
      expect(ownership.ownsDomain('test.victim.com', 'zattacker')).to.equal(false);
    });

    ['www.victim.com', 'xwww.victim.com', 'test.victim.com', 'https://WWW.victim.com'].forEach((claim) => {
      it(`does not let a later "${claim}" claim take the victim's hosts`, () => {
        const attacker = v4Spec('zattacker', [claim]);
        const ownership = ownershipFor([[victim, 1000], [attacker, 90000]]);
        boundNames(claim).forEach((host) => {
          const contested = boundNames('victim.com').includes(host);
          expect(ownership.ownsDomain(host, 'zattacker'), host).to.equal(!contested);
        });
      });
    });

    it('only withholds the overlapping host from a later claim on the parent domain', () => {
      const sub = v4Spec('subapp', ['test.foo.com']);
      const parent = v4Spec('parentapp', ['foo.com']);
      const ownership = ownershipFor([[sub, 1000], [parent, 90000]]);
      expect(ownership.ownsDomain('foo.com', 'parentapp')).to.equal(true);
      expect(ownership.ownsDomain('www.foo.com', 'parentapp')).to.equal(true);
      expect(ownership.ownsDomain('test.foo.com', 'parentapp')).to.equal(false);
    });

    it('dates a claim by the message that added the domain, not by the app age', () => {
      const oldApp = v4Spec('oldapp', ['other.com']);
      const oldAppUpdated = v4Spec('oldapp', ['victim.com']);
      const ownership = ownershipFor([[oldApp, 10], [victim, 1000], [oldAppUpdated, 90000]]);
      ownership.setLiveApps([victim, oldAppUpdated]);
      expect(ownership.ownsDomain('victim.com', 'oldapp')).to.equal(false);
      expect(ownership.ownsDomain('victim.com', 'victimapp')).to.equal(true);
    });

    it('does not let an older claim that binds a different host block the real owner', () => {
      const junk = v4Spec('junkapp', ['https://https://victim.com']); // FDM binds httpsvictim.com
      const ownership = ownershipFor([[junk, 10], [victim, 1000]]);
      expect(ownership.ownsDomain('victim.com', 'victimapp')).to.equal(true);
    });

    it('lets an expired app release its domain', () => {
      const attacker = v4Spec('zattacker', ['victim.com']);
      const ownership = ownershipFor([[victim, 1000], [attacker, 90000]]);
      ownership.setLiveApps([attacker]); // victimapp no longer live
      expect(ownership.ownsDomain('victim.com', 'zattacker')).to.equal(true);
    });

    it('does not drop an app whose claim cannot be dated (encrypted enterprise spec)', () => {
      const plain = v4Spec('plainapp', ['shared.com']);
      const enterpriseLive = v4Spec('entapp', ['shared.com']);
      const ownership = createDomainOwnership();
      ownership.setLiveApps([plain, enterpriseLive]);
      ownership.setPermanentMessages([
        message({
          name: 'entapp', version: 8, enterprise: 'base64...', compose: [],
        }, 10),
        message(plain, 90000),
      ]);
      expect(ownership.ownsDomain('shared.com', 'entapp')).to.equal(true);
      expect(ownership.ownsDomain('shared.com', 'plainapp')).to.equal(true);
    });
  });

  describe('addConfigurations', () => {
    // A newer non-g app claiming a g: app's domain. The non-g list is configured
    // first, so without a working check the first-come dedup gave it every host.
    ['victim.com', 'www.victim.com', 'xwww.victim.com', 'test.victim.com', ' victim.com'].forEach((claim) => {
      it(`keeps all of the victim's hosts on the victim when an attacker claims "${claim}"`, () => {
        const victim = v4Spec('vmcserver', ['victim.com']);
        const attacker = v4Spec('zstealer', [claim]);
        domainOwnership.setLiveApps([victim, attacker]);
        domainOwnership.setPermanentMessages([message(victim, 1000), message(attacker, 90000)]);

        const configuredApps = createConfiguredApps();
        addConfigurations(configuredApps, attacker, ['203.0.113.66:30001'], false);
        addConfigurations(configuredApps, victim, ['198.51.100.7:30001'], true);

        const owners = {};
        configuredApps.list().forEach((entry) => {
          if (!owners[entry.domain]) owners[entry.domain] = entry.name;
        });
        expect(owners['victim.com']).to.equal('vmcserver');
        expect(owners['www.victim.com']).to.equal('vmcserver');
        expect(owners['test.victim.com']).to.equal('vmcserver');
      });
    });
  });
});

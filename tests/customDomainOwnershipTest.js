const chai = require('chai');

const { expect } = chai;
const {
  canonicalDomain,
  boundNames,
  specDomains,
  appFromFluxDomain,
  createDomainOwnership,
} = require('../src/services/domain/customDomainOwnership');
const {
  addConfigurations,
  createConfiguredApps,
  domainOwnership,
} = require('../src/services/domainService');

// Shapes as the data fetcher emits them: live specs and permanent messages from
// apps/permanentmessages.
const v4Spec = (name, domains) => ({
  name,
  version: 4,
  compose: [{ name: 'web', ports: [30001], domains }],
});
const message = (spec, height) => ({ appSpecifications: spec, height });

// Stand-in resolver: only the given records exist; `fail` makes every lookup
// error the way an unreachable resolver does.
function fakeDns(cnames = {}, txts = {}, { fail = false, calls = [] } = {}) {
  const answer = (records, host) => {
    calls.push(host);
    const error = new Error(fail ? 'servfail' : 'nodata');
    error.code = fail ? 'ESERVFAIL' : 'ENODATA';
    return records[host] ? Promise.resolve(records[host]) : Promise.reject(error);
  };
  return {
    mainDomain: 'runonflux.io',
    resolveCname: (host) => answer(fail ? {} : cnames, host),
    resolveTxt: (host) => answer(fail ? {} : txts, host),
  };
}

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
      it(`keeps all of the victim's hosts on the victim when an attacker claims "${claim}"`, async () => {
        const victim = v4Spec('vmcserver', ['victim.com']);
        const attacker = v4Spec('zstealer', [claim]);
        domainOwnership.setLiveApps([victim, attacker]);
        domainOwnership.setPermanentMessages([message(victim, 1000), message(attacker, 90000)]);
        await domainOwnership.refreshDnsOwners(fakeDns());

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

  describe('DNS decides a contested domain', () => {
    const squatter = v4Spec('squatter', ['victim.com']);
    const realOwner = v4Spec('realowner', ['victim.com']);
    const hosts = ['victim.com', 'www.victim.com', 'test.victim.com'];

    it('reads the app out of a Flux domain', () => {
      expect(appFromFluxDomain('RealOwner.app.runonflux.io.', 'runonflux.io')).to.equal('realowner');
      expect(appFromFluxDomain('realowner_30001.app2.runonflux.io', 'runonflux.io')).to.equal('realowner');
      expect(appFromFluxDomain('victim.com.cdn.cloudflare.net', 'runonflux.io')).to.equal(null);
    });

    it('gives the domain to the app its CNAME points at, even if a squatter registered it first', async () => {
      const ownership = ownershipFor([[squatter, 10], [realOwner, 1000]]);
      await ownership.refreshDnsOwners(fakeDns({ 'victim.com': ['realowner_30001.app2.runonflux.io'] }));
      hosts.forEach((host) => {
        expect(ownership.ownsDomain(host, 'realowner'), host).to.equal(true);
        expect(ownership.ownsDomain(host, 'squatter'), host).to.equal(false);
      });
    });

    it('accepts a _flux TXT record for domains whose CNAME is hidden (Cloudflare proxy)', async () => {
      const ownership = ownershipFor([[squatter, 10], [realOwner, 1000]]);
      await ownership.refreshDnsOwners(fakeDns({}, { '_flux.victim.com': [['flux-app=RealOwner']] }));
      hosts.forEach((host) => {
        expect(ownership.ownsDomain(host, 'realowner'), host).to.equal(true);
        expect(ownership.ownsDomain(host, 'squatter'), host).to.equal(false);
      });
    });

    it('falls back to the first registrant when DNS names none of the claimants', async () => {
      const ownership = ownershipFor([[squatter, 10], [realOwner, 1000]]);
      await ownership.refreshDnsOwners(fakeDns({ 'victim.com': ['victim.com.cdn.cloudflare.net'] }));
      expect(ownership.ownsDomain('victim.com', 'squatter')).to.equal(true);
      expect(ownership.ownsDomain('victim.com', 'realowner')).to.equal(false);
    });

    it('falls back to the first registrant when DNS names more than one claimant', async () => {
      const ownership = ownershipFor([[squatter, 10], [realOwner, 1000]]);
      await ownership.refreshDnsOwners(fakeDns(
        { 'victim.com': ['realowner.app.runonflux.io'] },
        { '_flux.victim.com': [['flux-app=squatter']] },
      ));
      expect(ownership.ownsDomain('victim.com', 'squatter')).to.equal(true);
      expect(ownership.ownsDomain('victim.com', 'realowner')).to.equal(false);
    });

    it('keeps the last DNS answer when a refresh cannot reach the resolver', async () => {
      const ownership = ownershipFor([[squatter, 10], [realOwner, 1000]]);
      await ownership.refreshDnsOwners(fakeDns({ 'victim.com': ['realowner.app.runonflux.io'] }));
      await ownership.refreshDnsOwners(fakeDns({}, {}, { fail: true }));
      expect(ownership.ownsDomain('victim.com', 'realowner')).to.equal(true);
      expect(ownership.ownsDomain('victim.com', 'squatter')).to.equal(false);
    });

    it('never looks up an uncontested domain', async () => {
      const calls = [];
      const ownership = ownershipFor([[realOwner, 1000], [v4Spec('other', ['other.com']), 2000]]);
      await ownership.refreshDnsOwners(fakeDns({}, {}, { calls }));
      expect(calls).to.deep.equal([]);
    });

    it('routes every host to the DNS owner through addConfigurations, squatter configured first', async () => {
      const victim = v4Spec('vmcserver', ['victim.com']);
      const early = v4Spec('zsquatter', ['victim.com']);
      domainOwnership.setLiveApps([victim, early]);
      domainOwnership.setPermanentMessages([message(early, 10), message(victim, 1000)]);
      await domainOwnership.refreshDnsOwners(fakeDns({ 'victim.com': ['vmcserver.app.runonflux.io'] }));

      const configuredApps = createConfiguredApps();
      addConfigurations(configuredApps, early, ['203.0.113.66:30001'], false);
      addConfigurations(configuredApps, victim, ['198.51.100.7:30001'], true);

      const owners = {};
      configuredApps.list().forEach((entry) => {
        if (!owners[entry.domain]) owners[entry.domain] = entry.name;
      });
      hosts.forEach((host) => expect(owners[host], host).to.equal('vmcserver'));
    });
  });
});

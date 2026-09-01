/* eslint-disable func-names */
const chai = require('chai');

const { expect } = chai;
const serviceHelper = require('../src/services/serviceHelper');
const { orderBySeniority, orderByCluster } = require('../src/services/domainService');

// Shaped from a real /apps/location/owncloudssl response.
const loc = (ip, runningSince) => ({ ip, runningSince });
const LOCATIONS = [
  loc('64.32.48.71:16127', '2026-06-05T01:42:29.571Z'),
  loc('38.240.227.99:16127', '2026-06-19T19:08:45.792Z'),
  loc('184.145.185.59:16137', '2026-07-15T05:05:49.213Z'),
  loc('108.14.101.105:16127', '2026-07-20T16:34:08.142Z'),
];
const IPS = LOCATIONS.map((l) => l.ip);
const shuffled = [IPS[2], IPS[0], IPS[3], IPS[1]];

describe('backend ordering', () => {
  describe('orderBySeniority', () => {
    it('puts the longest-running instance first', () => {
      expect(orderBySeniority(IPS, LOCATIONS)[0]).to.equal('64.32.48.71:16127');
    });

    // THE PROPERTY THE RELOAD STORM NEEDED. api.runonflux.io returns the same
    // instances in a different order from one call to the next - measured
    // directly, three seconds apart - and the whole haproxy config is byte
    // compared to decide whether to reload it.
    it('gives the same order whatever order the locations arrive in', () => {
      expect(orderBySeniority(shuffled, LOCATIONS)).to.deep.equal(orderBySeniority(IPS, LOCATIONS));
    });

    // For a replicated app position zero takes the writes, so "no idea how long
    // this has been up" is the weakest claim on it, not the strongest. The
    // comparator this replaces read `a.runningSince` off a bare string, so it
    // returned 0 for every pair and never ordered anything at all.
    it('sorts an instance with no runningSince last, not first', () => {
      const withUnknown = [...LOCATIONS, loc('9.9.9.9:16127', undefined)];
      const ordered = orderBySeniority(withUnknown.map((l) => l.ip), withUnknown);
      expect(ordered[ordered.length - 1]).to.equal('9.9.9.9:16127');
    });

    it('does not mutate the array it was given', () => {
      const input = [...shuffled];
      orderBySeniority(input, LOCATIONS);
      expect(input).to.deep.equal(shuffled);
    });
  });

  describe('orderByCluster', () => {
    // clusterStatus[0] is the operator's elected master and its `ip` is
    // `ip:port`, the same shape as these - so this ordering is real, and
    // authoritative over any timestamp heuristic.
    const cluster = ['38.240.227.99:16127', '64.32.48.71:16127', '108.14.101.105:16127'];

    it('follows the cluster order, master first', () => {
      expect(orderByCluster(IPS, cluster, LOCATIONS).slice(0, 3)).to.deep.equal(cluster);
    });

    // indexOf returns -1 for an instance the cluster does not list - deployed,
    // but not joined - and -1 sorts AHEAD of index 0. That put a node outside
    // the database cluster in front of the master, and haproxy marks everything
    // after the first server `backup`, so it would have taken the writes.
    it('sorts an instance the cluster does not list LAST, never ahead of the master', () => {
      const ordered = orderByCluster(IPS, cluster, LOCATIONS);
      expect(ordered[0]).to.equal('38.240.227.99:16127');
      expect(ordered[ordered.length - 1]).to.equal('184.145.185.59:16137');
    });

    it('gives the same order whatever order the locations arrive in', () => {
      expect(orderByCluster(shuffled, cluster, LOCATIONS))
        .to.deep.equal(orderByCluster(IPS, cluster, LOCATIONS));
    });
  });

  describe('sortIPAddresses (the cosmetic path)', () => {
    it('gives the same order whatever order the locations arrive in', () => {
      expect(serviceHelper.sortIPAddresses([...shuffled]))
        .to.deep.equal(serviceHelper.sortIPAddresses([...IPS]));
    });
  });
});

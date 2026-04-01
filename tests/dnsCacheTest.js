/* eslint-disable func-names */
const chai = require('chai');
const dnsCache = require('../src/services/domain/dnsCache');

const { expect } = chai;

describe('dnsCache', () => {
  beforeEach(() => {
    // Reset cache by recording success for any test domains
    ['test1.example.com', 'test2.example.com', 'test3.example.com'].forEach((d) => {
      dnsCache.recordSuccess(d);
    });
  });

  describe('shouldCheckDomain', () => {
    it('returns true for unknown domains', () => {
      expect(dnsCache.shouldCheckDomain('never-seen.example.com')).to.equal(true);
    });

    it('returns true for domains with 1-3 failures (no cooldown)', () => {
      dnsCache.recordFailure('test1.example.com');
      expect(dnsCache.shouldCheckDomain('test1.example.com')).to.equal(true);

      dnsCache.recordFailure('test1.example.com');
      expect(dnsCache.shouldCheckDomain('test1.example.com')).to.equal(true);

      dnsCache.recordFailure('test1.example.com');
      expect(dnsCache.shouldCheckDomain('test1.example.com')).to.equal(true);
    });

    it('returns false for domains with 4+ failures within cooldown', () => {
      for (let i = 0; i < 4; i += 1) {
        dnsCache.recordFailure('test2.example.com');
      }
      // 4 failures = 1 hour cooldown, should skip immediately after
      expect(dnsCache.shouldCheckDomain('test2.example.com')).to.equal(false);
    });
  });

  describe('recordSuccess', () => {
    it('clears failure history', () => {
      for (let i = 0; i < 10; i += 1) {
        dnsCache.recordFailure('test3.example.com');
      }
      expect(dnsCache.shouldCheckDomain('test3.example.com')).to.equal(false);

      dnsCache.recordSuccess('test3.example.com');
      expect(dnsCache.shouldCheckDomain('test3.example.com')).to.equal(true);
    });
  });

  describe('getCacheSize', () => {
    it('tracks number of cached domains', () => {
      const before = dnsCache.getCacheSize();
      dnsCache.recordFailure('unique-test-domain-1.example.com');
      dnsCache.recordFailure('unique-test-domain-2.example.com');
      expect(dnsCache.getCacheSize()).to.equal(before + 2);

      // cleanup
      dnsCache.recordSuccess('unique-test-domain-1.example.com');
      dnsCache.recordSuccess('unique-test-domain-2.example.com');
    });
  });
});

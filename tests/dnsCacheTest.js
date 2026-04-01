/* eslint-disable func-names */
const chai = require('chai');
const dnsCache = require('../src/services/domain/dnsCache');

const { expect } = chai;

describe('dnsCache', () => {
  beforeEach(() => {
    ['test1.example.com', 'test2.example.com', 'test3.example.com'].forEach((d) => {
      dnsCache.recordSuccess(d);
    });
  });

  describe('getCooldownMs', () => {
    it('returns 0 for first failure (recheck next cycle)', () => {
      expect(dnsCache.getCooldownMs(1)).to.equal(0);
    });

    it('returns 30m for second failure', () => {
      expect(dnsCache.getCooldownMs(2)).to.equal(30 * 60 * 1000);
    });

    it('returns 1h for third failure', () => {
      expect(dnsCache.getCooldownMs(3)).to.equal(60 * 60 * 1000);
    });

    it('caps at 2 hours', () => {
      expect(dnsCache.getCooldownMs(4)).to.equal(2 * 60 * 60 * 1000);
      expect(dnsCache.getCooldownMs(10)).to.equal(2 * 60 * 60 * 1000);
      expect(dnsCache.getCooldownMs(100)).to.equal(2 * 60 * 60 * 1000);
    });
  });

  describe('shouldCheckDomain', () => {
    it('returns true for unknown domains', () => {
      expect(dnsCache.shouldCheckDomain('never-seen.example.com')).to.equal(true);
    });

    it('returns true after first failure (no cooldown)', () => {
      dnsCache.recordFailure('test1.example.com');
      expect(dnsCache.shouldCheckDomain('test1.example.com')).to.equal(true);
    });

    it('returns false after second failure within cooldown', () => {
      dnsCache.recordFailure('test2.example.com');
      dnsCache.recordFailure('test2.example.com');
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
      dnsCache.recordFailure('unique-test-1.example.com');
      dnsCache.recordFailure('unique-test-2.example.com');
      expect(dnsCache.getCacheSize()).to.equal(before + 2);

      dnsCache.recordSuccess('unique-test-1.example.com');
      dnsCache.recordSuccess('unique-test-2.example.com');
    });
  });
});

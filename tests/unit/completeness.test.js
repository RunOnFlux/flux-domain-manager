// A cycle that built far fewer routes than the last good one has probably built them from
// an incomplete view of the network. Withholding leaves haproxy on the last good config,
// which is the safe failure — but it must not be able to withhold forever, or a population
// that genuinely shrank would freeze routing permanently.
const { expect } = require('chai');
const { assessRouteConfigs } = require('../../src/services/haproxy/completeness');

const LIMITS = { minRouteConfigs: 10, minRouteRetention: 0.7, maxConsecutiveWithholds: 3 };

const assess = (count, lastGoodCount, consecutiveWithholds = 0) => assessRouteConfigs({
  count, lastGoodCount, consecutiveWithholds, limits: LIMITS,
});

describe('publish guard — is this cycle complete enough to publish', () => {
  describe('cold start, with nothing to compare against', () => {
    it('publishes a plausible first config', () => {
      expect(assess(1455, null).publish).to.equal(true);
    });

    it('withholds a first config below the absolute floor', () => {
      const verdict = assess(4, null);
      expect(verdict.publish).to.equal(false);
      expect(verdict.reason).to.contain('first cycle');
    });

    it('publishes exactly at the floor', () => {
      expect(assess(10, null).publish).to.equal(true);
    });
  });

  describe('with a previous good cycle to compare against', () => {
    it('publishes an unchanged population', () => {
      expect(assess(1455, 1455).publish).to.equal(true);
    });

    it('publishes ordinary churn', () => {
      expect(assess(1450, 1455).publish).to.equal(true);
      expect(assess(1470, 1455).publish).to.equal(true);
    });

    it('publishes a large but plausible drop, just above the threshold', () => {
      expect(assess(1019, 1455).publish).to.equal(true); // 70% of 1455 is 1018
    });

    it('withholds a collapse', () => {
      const verdict = assess(700, 1455);
      expect(verdict.publish).to.equal(false);
      expect(verdict.reason).to.contain('1018');
      expect(verdict.reason).to.contain('1455');
    });

    it('withholds a total collapse to nothing', () => {
      expect(assess(0, 1455).publish).to.equal(false);
    });

    // The floor scales with the population, so it does not rot as the network grows.
    it('scales its threshold with the population', () => {
      expect(assess(80, 100).publish).to.equal(true);
      expect(assess(80, 1000).publish).to.equal(false);
    });
  });

  describe('bounded: it cannot withhold forever', () => {
    it('keeps withholding below the limit', () => {
      expect(assess(700, 1455, 0).publish).to.equal(false);
      expect(assess(700, 1455, 2).publish).to.equal(false);
    });

    it('publishes anyway once the limit is reached, and says it overrode itself', () => {
      const verdict = assess(700, 1455, 3);
      expect(verdict.publish).to.equal(true);
      expect(verdict.overridden).to.equal(true);
      expect(verdict.reason).to.contain('publishing anyway');
    });

    it('does not claim an override when the config was fine all along', () => {
      const verdict = assess(1455, 1455, 3);
      expect(verdict.publish).to.equal(true);
      expect(verdict.overridden).to.equal(false);
      expect(verdict.reason).to.equal(null);
    });
  });
});

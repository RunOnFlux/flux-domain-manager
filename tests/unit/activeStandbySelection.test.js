// Active-standby picks the ONE instance that serves; the rest are warm standbys sharing
// state through syncthing, and two serving at once is the corruption the mode exists to
// prevent. The unit of selection is an instance — `{ ip, replica }` — not a node, because
// a node can host several co-located replicas of the same app.
//
// A loose (unnamed) instance IS its node, so every legacy app must behave exactly as it
// did before: same lowest-digit-sum ordering, same sticky identity, same unhealthy grace
// period. Those cases are asserted here alongside the co-located ones.
//
// The health probe is injected rather than stubbed globally: selection is pure decision
// logic over "is this instance alive", and the network call is not what is under test.
const chai = require('chai');
const { selectActiveInstance } = require('../../src/services/domainService');

const { expect } = chai;

// Module-level sticky state is keyed by app name, so every test uses its own.
let appCounter = 0;
const freshApp = () => {
  appCounter += 1;
  return { name: `standbyapp${appCounter}` };
};

const instance = (ip, replica = null) => ({ ip, replica });

// A probe that answers from a set of healthy instance keys, recording what it was asked.
const probeFor = (healthy, calls = []) => {
  const ok = new Set(healthy);
  return async (candidate) => {
    calls.push(candidate.replica ? `${candidate.ip}#${candidate.replica}` : candidate.ip);
    return ok.has(candidate.replica ? `${candidate.ip}#${candidate.replica}` : candidate.ip);
  };
};

// 1.1.1.1 sums to 4, 9.9.9.9 to 36 — the first is the lowest-digit-sum node.
const LOW = '1.1.1.1:16127';
const HIGH = '9.9.9.9:16127';

describe('active-standby instance selection', () => {
  describe('loose instances behave exactly as before', () => {
    it('selects the lowest-digit-sum node when all are healthy', async () => {
      const chosen = await selectActiveInstance([instance(HIGH), instance(LOW)], freshApp(), probeFor([LOW, HIGH]));
      expect(chosen).to.deep.equal(instance(LOW));
    });

    it('falls through to another node when the preferred one is unhealthy', async () => {
      const chosen = await selectActiveInstance([instance(HIGH), instance(LOW)], freshApp(), probeFor([HIGH]));
      expect(chosen).to.deep.equal(instance(HIGH));
    });

    it('returns null when nothing is healthy', async () => {
      const chosen = await selectActiveInstance([instance(HIGH), instance(LOW)], freshApp(), probeFor([]));
      expect(chosen).to.equal(null);
    });

    it('returns null for no instances', async () => {
      expect(await selectActiveInstance([], freshApp(), probeFor([]))).to.equal(null);
      expect(await selectActiveInstance(undefined, freshApp(), probeFor([]))).to.equal(null);
    });

    it('sticks to its selection across cycles', async () => {
      const app = freshApp();
      const first = await selectActiveInstance([instance(HIGH)], app, probeFor([HIGH]));
      expect(first).to.deep.equal(instance(HIGH));
      // LOW is now available and would win on digit sum, but the sticky instance holds.
      const second = await selectActiveInstance([instance(HIGH), instance(LOW)], app, probeFor([LOW, HIGH]));
      expect(second).to.deep.equal(instance(HIGH));
    });

    it('keeps an unhealthy sticky instance inside the grace period', async () => {
      const app = freshApp();
      await selectActiveInstance([instance(HIGH)], app, probeFor([HIGH]));
      // Just went unhealthy — recently healthy, so it is held rather than flapped away.
      const held = await selectActiveInstance([instance(HIGH), instance(LOW)], app, probeFor([LOW]));
      expect(held).to.deep.equal(instance(HIGH));
    });

    it('fails over once the sticky instance is gone from the locations', async () => {
      const app = freshApp();
      await selectActiveInstance([instance(HIGH)], app, probeFor([HIGH]));
      const failedOver = await selectActiveInstance([instance(LOW)], app, probeFor([LOW]));
      expect(failedOver).to.deep.equal(instance(LOW));
    });
  });

  describe('co-located replicas', () => {
    it('selects ONE replica, not the node', async () => {
      const chosen = await selectActiveInstance(
        [instance(LOW, 'blue'), instance(LOW, 'green')],
        freshApp(),
        probeFor([`${LOW}#blue`, `${LOW}#green`]),
      );
      expect(chosen).to.deep.equal(instance(LOW, 'blue'));
    });

    it('asks the health probe about the specific replica', async () => {
      const calls = [];
      await selectActiveInstance(
        [instance(LOW, 'blue'), instance(LOW, 'green')],
        freshApp(),
        probeFor([`${LOW}#green`], calls),
      );
      // blue is probed and fails, green is probed and passes — the node alone could not
      // have distinguished them.
      expect(calls).to.deep.equal([`${LOW}#blue`, `${LOW}#green`]);
    });

    it('picks a healthy replica when its co-located sibling is down', async () => {
      const chosen = await selectActiveInstance(
        [instance(LOW, 'blue'), instance(LOW, 'green')],
        freshApp(),
        probeFor([`${LOW}#green`]),
      );
      expect(chosen).to.deep.equal(instance(LOW, 'green'));
    });

    it('breaks ties on replica name, so every director agrees', async () => {
      const healthy = [`${LOW}#alpha`, `${LOW}#omega`];
      const first = await selectActiveInstance([instance(LOW, 'omega'), instance(LOW, 'alpha')], freshApp(), probeFor(healthy));
      const second = await selectActiveInstance([instance(LOW, 'alpha'), instance(LOW, 'omega')], freshApp(), probeFor(healthy));
      expect(first).to.deep.equal(instance(LOW, 'alpha'));
      expect(second).to.deep.equal(instance(LOW, 'alpha'));
    });

    it('prefers the lowest-digit-sum node before breaking ties on replica', async () => {
      const chosen = await selectActiveInstance(
        [instance(HIGH, 'alpha'), instance(LOW, 'zulu')],
        freshApp(),
        probeFor([`${HIGH}#alpha`, `${LOW}#zulu`]),
      );
      expect(chosen).to.deep.equal(instance(LOW, 'zulu'));
    });

    it('sticks to a replica, not to its node', async () => {
      const app = freshApp();
      const first = await selectActiveInstance([instance(LOW, 'green')], app, probeFor([`${LOW}#green`]));
      expect(first).to.deep.equal(instance(LOW, 'green'));
      // blue joins the same node and sorts first, but green is the sticky instance.
      const second = await selectActiveInstance(
        [instance(LOW, 'blue'), instance(LOW, 'green')],
        app,
        probeFor([`${LOW}#blue`, `${LOW}#green`]),
      );
      expect(second).to.deep.equal(instance(LOW, 'green'));
    });

    it('fails over to the sibling replica when the sticky one leaves the node', async () => {
      const app = freshApp();
      await selectActiveInstance([instance(LOW, 'green')], app, probeFor([`${LOW}#green`]));
      const failedOver = await selectActiveInstance([instance(LOW, 'blue')], app, probeFor([`${LOW}#blue`]));
      expect(failedOver).to.deep.equal(instance(LOW, 'blue'));
    });

    it('a replica and a loose instance on the same node are different instances', async () => {
      const app = freshApp();
      await selectActiveInstance([instance(LOW, 'blue')], app, probeFor([`${LOW}#blue`]));
      // The loose instance is not the sticky one, so it is selected on its own merits.
      const chosen = await selectActiveInstance([instance(LOW)], app, probeFor([LOW]));
      expect(chosen).to.deep.equal(instance(LOW));
    });
  });
});

// The routing loops run every time the fetcher emits locations — every 10 seconds,
// unconditionally. Anything logged straight from a loop body while a condition holds is
// emitted thousands of times a day per app, which buries the event it was meant to
// surface. ConditionLog logs the edges and a periodic re-assertion instead.
const { expect } = require('chai');
const log = require('../../src/lib/log');
const { ConditionLog } = require('../../src/services/conditionLog');

describe('ConditionLog', () => {
  let lines;
  let originals;

  beforeEach(() => {
    lines = [];
    originals = { info: log.info, warn: log.warn };
    log.info = (m) => lines.push(`info: ${m}`);
    log.warn = (m) => lines.push(`warn: ${m}`);
  });

  afterEach(() => { log.info = originals.info; log.warn = originals.warn; });

  // A clock the test drives, so no timers and no real waiting.
  const at = (start = 0) => {
    const clock = { t: start };
    return { clock, now: () => clock.t };
  };

  it('says nothing while the condition does not hold', () => {
    const { now } = at();
    const c = new ConditionLog({ now });
    for (let i = 0; i < 100; i += 1) c.report('app', false, () => 'x');
    expect(lines).to.have.lengthOf(0);
  });

  it('logs once when the condition starts, then stays quiet', () => {
    const { clock, now } = at();
    const c = new ConditionLog({ reassertMs: 15 * 60 * 1000, now });
    // 60 cycles at 10s apart — ten minutes of a persistent condition
    for (let i = 0; i < 60; i += 1) {
      c.report('explorer', true, () => 'explorer has no healthy instances');
      clock.t += 10_000;
    }
    expect(lines).to.have.lengthOf(1);
    expect(lines[0]).to.equal('warn: explorer has no healthy instances');
  });

  it('restates a persistent condition on the interval, with how long it has held', () => {
    const { clock, now } = at();
    const c = new ConditionLog({ reassertMs: 15 * 60 * 1000, now });
    // a full hour at 10s intervals, inclusive of the report at exactly 60 minutes
    for (let i = 0; i <= 360; i += 1) {
      c.report('explorer', true, () => 'explorer has no healthy instances');
      clock.t += 10_000;
    }
    // one start, then a re-assertion at 15, 30, 45 and 60 minutes
    expect(lines).to.have.lengthOf(5);
    expect(lines[1]).to.contain('ongoing for 15 minutes');
    expect(lines[4]).to.contain('ongoing for 1 hour');
  });

  it('logs the recovery, with how long it lasted', () => {
    const { clock, now } = at();
    const c = new ConditionLog({ now });
    c.report('explorer', true, () => 'explorer has no healthy instances');
    clock.t += 20 * 60 * 1000;
    c.report('explorer', false, () => 'explorer has no healthy instances');
    expect(lines).to.have.lengthOf(2);
    expect(lines[1]).to.contain('cleared after 20 minutes');
  });

  it('stays quiet once cleared, and starts fresh if it recurs', () => {
    const { clock, now } = at();
    const c = new ConditionLog({ now });
    c.report('a', true, () => 'a');
    c.report('a', false, () => 'a');
    for (let i = 0; i < 50; i += 1) { c.report('a', false, () => 'a'); clock.t += 10_000; }
    expect(lines).to.have.lengthOf(2);
    c.report('a', true, () => 'a');
    expect(lines).to.have.lengthOf(3);
  });

  it('tracks each key independently', () => {
    const { now } = at();
    const c = new ConditionLog({ now });
    c.report('a', true, () => 'a down');
    c.report('b', true, () => 'b down');
    c.report('a', true, () => 'a down');
    expect(lines).to.have.lengthOf(2);
    expect(c.activeCount).to.equal(2);
    c.report('a', false, () => 'a down');
    expect(c.activeCount).to.equal(1);
  });

  it('does not build the message when it has nothing to log', () => {
    const { now } = at();
    const c = new ConditionLog({ now });
    let built = 0;
    const describe = () => { built += 1; return 'x'; };
    c.report('a', true, describe);
    expect(built).to.equal(1);
    for (let i = 0; i < 20; i += 1) c.report('a', true, describe);
    expect(built).to.equal(1);
  });
});

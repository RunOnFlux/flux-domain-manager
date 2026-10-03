const chai = require('chai');
const { evaluateListChange } = require('../src/lib/listGuard');

const { expect } = chai;

const limits = { floor: 5, maxDropRatio: 0.3, confirmMs: 600_000 };

const none = { lastAcceptedCount: null, pendingSince: null };

function accepted(count) {
  return { lastAcceptedCount: count, pendingSince: null };
}

describe('evaluateListChange', () => {
  it('holds a first list below the floor and makes an accepted one the baseline', () => {
    expect(evaluateListChange(4, none, limits, 0)).to.include({ accept: false, reason: 'below-floor' });
    const verdict = evaluateListChange(5, none, limits, 0);
    expect(verdict).to.include({ accept: true, reason: null });
    expect(verdict.state).to.deep.equal(accepted(5));
  });

  it('accepts a first list below the floor once it has held for confirmMs', () => {
    const first = evaluateListChange(0, none, limits, 1_000);
    expect(first.state).to.deep.equal({ lastAcceptedCount: null, pendingSince: 1_000 });
    expect(evaluateListChange(0, first.state, limits, 1_000 + limits.confirmMs - 1).accept).to.equal(false);
    const held = evaluateListChange(0, first.state, limits, 1_000 + limits.confirmMs);
    expect(held).to.include({ accept: true, reason: 'confirmed' });
    expect(held.state).to.deep.equal(accepted(0));
  });

  it('accepts a drop of exactly the ratio and refuses one just over it', () => {
    expect(evaluateListChange(700, accepted(1000), limits, 0).accept).to.equal(true);
    expect(evaluateListChange(699, accepted(1000), limits, 0)).to.include({ accept: false, reason: 'drop' });
  });

  it('judges a small list on the same ratio, below the floor included', () => {
    expect(evaluateListChange(6, accepted(10), limits, 0)).to.include({ accept: false, reason: 'drop' });
    expect(evaluateListChange(3, accepted(4), limits, 0).accept).to.equal(true);
  });

  it('refuses a drop until it has held for confirmMs, then accepts it as the new baseline', () => {
    const first = evaluateListChange(1135, accepted(1750), limits, 1_000);
    expect(first).to.include({ accept: false, reason: 'drop' });
    expect(first.state).to.deep.equal({ lastAcceptedCount: 1750, pendingSince: 1_000 });

    const almost = evaluateListChange(1135, first.state, limits, 1_000 + limits.confirmMs - 1);
    expect(almost.accept).to.equal(false);
    expect(almost.state.pendingSince).to.equal(1_000);

    const held = evaluateListChange(1135, almost.state, limits, 1_000 + limits.confirmMs);
    expect(held).to.include({ accept: true, reason: 'confirmed' });
    expect(held.state).to.deep.equal(accepted(1135));
  });

  it('treats an empty list as a drop: refused, then accepted once it has held', () => {
    const first = evaluateListChange(0, accepted(1776), limits, 0);
    expect(first).to.include({ accept: false, reason: 'drop' });
    expect(first.state.lastAcceptedCount).to.equal(1776);
    const held = evaluateListChange(0, first.state, limits, limits.confirmMs);
    expect(held).to.include({ accept: true, reason: 'confirmed' });
    expect(held.state).to.deep.equal(accepted(0));
  });

  it('grows from an empty baseline without waiting', () => {
    expect(evaluateListChange(1, accepted(0), limits, 0)).to.include({ accept: true, reason: null });
  });

  it('clears a pending drop when a result comes back within the ratio', () => {
    const refused = evaluateListChange(100, accepted(1750), limits, 0);
    const recovered = evaluateListChange(1740, refused.state, limits, 30_000);
    expect(recovered.accept).to.equal(true);
    expect(recovered.state).to.deep.equal(accepted(1740));

    const again = evaluateListChange(100, recovered.state, limits, 60_000);
    expect(again.state.pendingSince).to.equal(60_000);
  });
});

/* eslint-disable func-names */
const chai = require('chai');
const { evaluateListChange, initialListState } = require('../src/lib/listGuard');

const { expect } = chai;

const limits = { floor: 10, maxDropRatio: 0.3, confirmMs: 600_000 };

function accepted(count) {
  return { lastAcceptedCount: count, dropSince: null };
}

describe('evaluateListChange', () => {
  it('refuses an empty list, before and after a baseline exists', () => {
    expect(evaluateListChange(0, initialListState(), limits, 0)).to.include({ accept: false, reason: 'empty' });
    expect(evaluateListChange(0, accepted(1776), limits, 0)).to.include({ accept: false, reason: 'empty' });
  });

  it('holds the first list to the floor and makes an accepted one the baseline', () => {
    expect(evaluateListChange(9, initialListState(), limits, 0)).to.include({ accept: false, reason: 'below-floor' });
    const verdict = evaluateListChange(10, initialListState(), limits, 0);
    expect(verdict.accept).to.equal(true);
    expect(verdict.state).to.deep.equal(accepted(10));
  });

  it('accepts a drop of exactly the ratio and refuses one just over it', () => {
    expect(evaluateListChange(700, accepted(1000), limits, 0).accept).to.equal(true);
    expect(evaluateListChange(699, accepted(1000), limits, 0)).to.include({ accept: false, reason: 'drop' });
  });

  it('judges a small network on the same ratio', () => {
    expect(evaluateListChange(6, accepted(10), limits, 0)).to.include({ accept: false, reason: 'drop' });
    expect(evaluateListChange(7, accepted(10), limits, 0).accept).to.equal(true);
  });

  it('refuses a drop until it has held for confirmMs, then accepts it as the new baseline', () => {
    const first = evaluateListChange(1135, accepted(1750), limits, 1_000);
    expect(first).to.include({ accept: false, reason: 'drop' });
    expect(first.state).to.deep.equal({ lastAcceptedCount: 1750, dropSince: 1_000 });

    const almost = evaluateListChange(1135, first.state, limits, 1_000 + limits.confirmMs - 1);
    expect(almost.accept).to.equal(false);
    expect(almost.state.dropSince).to.equal(1_000);

    const held = evaluateListChange(1135, almost.state, limits, 1_000 + limits.confirmMs);
    expect(held).to.include({ accept: true, reason: 'confirmed-drop' });
    expect(held.state).to.deep.equal(accepted(1135));
  });

  it('clears a pending drop when a result comes back within the ratio', () => {
    const refused = evaluateListChange(100, accepted(1750), limits, 0);
    const recovered = evaluateListChange(1740, refused.state, limits, 30_000);
    expect(recovered.accept).to.equal(true);
    expect(recovered.state).to.deep.equal(accepted(1740));

    const again = evaluateListChange(100, recovered.state, limits, 60_000);
    expect(again.state.dropSince).to.equal(60_000);
  });

  it('does not let a refused list move the baseline', () => {
    const refused = evaluateListChange(0, accepted(1776), limits, 0);
    expect(refused.state.lastAcceptedCount).to.equal(1776);
  });
});

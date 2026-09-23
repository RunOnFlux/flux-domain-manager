/* eslint-disable func-names */
const chai = require('chai');
const config = require('config');
const domainService = require('../src/services/domainService');

const { expect } = chai;
const { admitConfiguredHalf, resetConfiguredHalfGuards } = domainService;

describe('config-pass guard', () => {
  const { confirmMs } = config.guards.configPass;

  beforeEach(() => { resetConfiguredHalfGuards(); });

  it('holds a G half with nothing to publish back, as before', () => {
    expect(admitConfiguredHalf('G', 0, 0)).to.equal(false);
    expect(admitConfiguredHalf('G', 3, 0)).to.equal(true);
  });

  it('holds the non-G half to its floor before it has published', () => {
    expect(admitConfiguredHalf('nonG', 9, 0)).to.equal(false);
    expect(admitConfiguredHalf('nonG', 10, 0)).to.equal(true);
  });

  // The FDM-US-01 incident: the G half went from 615 entries to none.
  it('refuses a collapsed G half and keeps refusing an empty one', () => {
    expect(admitConfiguredHalf('G', 615, 0)).to.equal(true);
    expect(admitConfiguredHalf('G', 0, 1_000)).to.equal(false);
    expect(admitConfiguredHalf('G', 0, 1_000 + confirmMs)).to.equal(false);
  });

  it('publishes a genuine drop once it has held for the confirmation window', () => {
    expect(admitConfiguredHalf('nonG', 1135, 0)).to.equal(true);
    expect(admitConfiguredHalf('nonG', 500, 1_000)).to.equal(false);
    expect(admitConfiguredHalf('nonG', 500, 1_000 + confirmMs - 1)).to.equal(false);
    expect(admitConfiguredHalf('nonG', 500, 1_000 + confirmMs)).to.equal(true);
  });

  it('guards each half separately', () => {
    expect(admitConfiguredHalf('nonG', 1135, 0)).to.equal(true);
    expect(admitConfiguredHalf('G', 615, 0)).to.equal(true);
    expect(admitConfiguredHalf('G', 100, 1_000)).to.equal(false);
    expect(admitConfiguredHalf('nonG', 1130, 1_000)).to.equal(true);
  });
});

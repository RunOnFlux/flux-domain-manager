const chai = require('chai');
const config = require('config');
const fs = require('fs');
const os = require('os');
const path = require('path');
const domainService = require('../src/services/domainService');
const { createGuardStore } = require('../src/lib/guardStore');

const { expect } = chai;
const { admitConfiguredHalf, resetConfiguredHalfGuards } = domainService;

describe('config-pass guard', () => {
  const { confirmMs } = config.guards.configPass;
  let dir;
  let file;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fdm-config-guard-'));
    file = path.join(dir, 'list-guards.json');
    resetConfiguredHalfGuards(createGuardStore(file));
  });

  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('holds either half to the floor before it has ever published', () => {
    expect(admitConfiguredHalf('G', 4, 0)).to.equal(false);
    expect(admitConfiguredHalf('nonG', 4, 0)).to.equal(false);
    expect(admitConfiguredHalf('G', 5, 0)).to.equal(true);
    expect(admitConfiguredHalf('nonG', 5, 0)).to.equal(true);
  });

  it('publishes a half below the floor once it has held for the confirmation window', () => {
    expect(admitConfiguredHalf('G', 0, 0)).to.equal(false);
    expect(admitConfiguredHalf('G', 0, confirmMs)).to.equal(true);
  });

  // The FDM-US-01 incident: the G half went from 615 entries to none.
  it('refuses a collapsed G half until the collapse has held for the confirmation window', () => {
    expect(admitConfiguredHalf('G', 615, 0)).to.equal(true);
    expect(admitConfiguredHalf('G', 0, 1_000)).to.equal(false);
    expect(admitConfiguredHalf('G', 0, 1_000 + confirmMs - 1)).to.equal(false);
    expect(admitConfiguredHalf('G', 0, 1_000 + confirmMs)).to.equal(true);
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

  it('judges the first pass after a restart against what was published before it', () => {
    expect(admitConfiguredHalf('G', 615, 0)).to.equal(true);
    expect(admitConfiguredHalf('nonG', 1135, 0)).to.equal(true);

    resetConfiguredHalfGuards(createGuardStore(file));
    expect(admitConfiguredHalf('G', 74, 0)).to.equal(false);
    expect(admitConfiguredHalf('nonG', 1100, 0)).to.equal(true);
  });
});

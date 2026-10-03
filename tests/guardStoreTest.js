const chai = require('chai');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createGuardStore } = require('../src/lib/guardStore');

const { expect } = chai;

describe('guard store', () => {
  let dir;
  let file;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fdm-guard-store-'));
    file = path.join(dir, 'state', 'list-guards.json');
  });

  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('starts with nothing accepted when the file does not exist', () => {
    expect(createGuardStore(file).initialState('G')).to.deep.equal({ lastAcceptedCount: null, pendingSince: null });
  });

  it('gives a new store the counts an earlier one accepted', () => {
    const before = createGuardStore(file);
    before.recordAccepted('nonG', 1135);
    before.recordAccepted('G', 0);

    const after = createGuardStore(file);
    expect(after.initialState('nonG')).to.deep.equal({ lastAcceptedCount: 1135, pendingSince: null });
    expect(after.initialState('G').lastAcceptedCount).to.equal(0);
    expect(after.initialState('specList').lastAcceptedCount).to.equal(null);
    expect(fs.readdirSync(path.dirname(file))).to.deep.equal(['list-guards.json']);
  });

  it('starts with nothing accepted when the file is unreadable or holds a bad count', () => {
    fs.mkdirSync(path.dirname(file));
    fs.writeFileSync(file, '{"nonG": 11');
    expect(createGuardStore(file).initialState('nonG').lastAcceptedCount).to.equal(null);
    fs.writeFileSync(file, '{"nonG": -1, "G": "7"}');
    const store = createGuardStore(file);
    expect(store.initialState('nonG').lastAcceptedCount).to.equal(null);
    expect(store.initialState('G').lastAcceptedCount).to.equal(null);
  });

  it('keeps working in memory when the file cannot be written', () => {
    fs.writeFileSync(path.join(dir, 'state'), 'a file where the directory should be');
    const store = createGuardStore(file);
    expect(() => store.recordAccepted('G', 615)).to.not.throw();
  });
});

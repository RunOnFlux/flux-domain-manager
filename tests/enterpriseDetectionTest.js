/* eslint-disable func-names */
const chai = require('chai');

const { expect } = chai;

// Test the enterprise detection logic used in getDecryptedSpecs and processAppSpecs
function isEnterprise(spec) {
  return Boolean(spec.version >= 8 && spec.enterprise);
}

describe('enterprise app detection', () => {
  it('detects enterprise apps with version >= 8 and enterprise field', () => {
    const spec = { version: 8, name: 'tiktokss', enterprise: 'base64encrypteddata...' };
    expect(isEnterprise(spec)).to.equal(true);
  });

  it('returns false for non-enterprise apps', () => {
    const spec = { version: 7, name: 'regularapp', compose: [{ ports: [3000], domains: ['example.com'] }] };
    expect(isEnterprise(spec)).to.equal(false);
  });

  it('returns false for version 8 with empty enterprise field', () => {
    const spec = { version: 8, name: 'decrypted', enterprise: '' };
    expect(isEnterprise(spec)).to.equal(false);
  });

  it('returns false for version 8 with no enterprise field', () => {
    const spec = { version: 8, name: 'noenterprise' };
    expect(isEnterprise(spec)).to.equal(false);
  });

  it('returns false for older versions even with enterprise field', () => {
    const spec = { version: 7, name: 'oldversion', enterprise: 'somedata' };
    expect(isEnterprise(spec)).to.equal(false);
  });

  it('classifies mixed specs correctly', () => {
    const specs = [
      { version: 8, name: 'enterprise1', enterprise: 'encrypted' },
      { version: 7, name: 'regular1', compose: [] },
      { version: 8, name: 'enterprise2', enterprise: 'encrypted2' },
      { version: 8, name: 'decrypted', enterprise: '' },
      null,
      { version: 4, name: 'oldapp', compose: [] },
    ];

    const enterpriseApps = [];
    const regularApps = [];
    for (const spec of specs) {
      if (!spec) continue;
      if (isEnterprise(spec)) {
        enterpriseApps.push(spec);
      } else {
        regularApps.push(spec);
      }
    }

    expect(enterpriseApps).to.have.lengthOf(2);
    expect(enterpriseApps.map((s) => s.name)).to.deep.equal(['enterprise1', 'enterprise2']);
    expect(regularApps).to.have.lengthOf(3);
    expect(regularApps.map((s) => s.name)).to.deep.equal(['regular1', 'decrypted', 'oldapp']);
  });
});

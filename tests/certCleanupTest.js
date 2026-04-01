/* eslint-disable func-names */
const chai = require('chai');
const { shouldRemoveOrphanedCert } = require('../src/services/domain/cert');

const { expect } = chai;

describe('shouldRemoveOrphanedCert', () => {
  const activeDomains = new Set(['active.example.com', 'www.active.example.com']);

  it('returns false for active domains regardless of expiry', () => {
    expect(shouldRemoveOrphanedCert('active.example.com', activeDomains, -365)).to.equal(false);
    expect(shouldRemoveOrphanedCert('www.active.example.com', activeDomains, -100)).to.equal(false);
  });

  it('returns true for orphaned certs expired > 30 days', () => {
    expect(shouldRemoveOrphanedCert('old.example.com', activeDomains, -31)).to.equal(true);
    expect(shouldRemoveOrphanedCert('old.example.com', activeDomains, -365)).to.equal(true);
    expect(shouldRemoveOrphanedCert('old.example.com', activeDomains, -1000)).to.equal(true);
  });

  it('returns false for orphaned certs expired <= 30 days', () => {
    expect(shouldRemoveOrphanedCert('recent.example.com', activeDomains, -30)).to.equal(false);
    expect(shouldRemoveOrphanedCert('recent.example.com', activeDomains, -1)).to.equal(false);
    expect(shouldRemoveOrphanedCert('recent.example.com', activeDomains, 0)).to.equal(false);
  });

  it('returns false for orphaned certs that are still valid', () => {
    expect(shouldRemoveOrphanedCert('orphan.example.com', activeDomains, 60)).to.equal(false);
    expect(shouldRemoveOrphanedCert('orphan.example.com', activeDomains, 1)).to.equal(false);
  });

  it('returns false when daysRemaining is null (unreadable cert)', () => {
    expect(shouldRemoveOrphanedCert('broken.example.com', activeDomains, null)).to.equal(false);
  });

  it('works with empty active domains set', () => {
    const empty = new Set();
    expect(shouldRemoveOrphanedCert('any.example.com', empty, -31)).to.equal(true);
    expect(shouldRemoveOrphanedCert('any.example.com', empty, 10)).to.equal(false);
  });
});

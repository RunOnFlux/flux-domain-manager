/* eslint-disable func-names */
const chai = require('chai');
const { shouldRemoveStaleCert } = require('../src/services/domain/cert');

const { expect } = chai;

describe('shouldRemoveStaleCert', () => {
  it('returns true for certs expired > 30 days', () => {
    expect(shouldRemoveStaleCert(-31)).to.equal(true);
    expect(shouldRemoveStaleCert(-365)).to.equal(true);
    expect(shouldRemoveStaleCert(-1000)).to.equal(true);
  });

  it('returns false for certs expired <= 30 days', () => {
    expect(shouldRemoveStaleCert(-30)).to.equal(false);
    expect(shouldRemoveStaleCert(-1)).to.equal(false);
    expect(shouldRemoveStaleCert(0)).to.equal(false);
  });

  it('returns false for valid certs', () => {
    expect(shouldRemoveStaleCert(1)).to.equal(false);
    expect(shouldRemoveStaleCert(60)).to.equal(false);
    expect(shouldRemoveStaleCert(365)).to.equal(false);
  });

  it('returns false when daysRemaining is null (unreadable cert)', () => {
    expect(shouldRemoveStaleCert(null)).to.equal(false);
  });
});

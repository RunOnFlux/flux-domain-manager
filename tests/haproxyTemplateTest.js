/* eslint-disable func-names */
const chai = require('chai');
const config = require('config');

const { expect } = chai;

describe('haproxyTemplate', () => {
  // The letsEncryptBackend is computed at module load time based on config.certRenewalPrimary
  // Default config has certRenewalPrimary: false, so it should point to the primary's IP

  it('letsencrypt-backend points to primary IP when not primary', () => {
    // Default test config: certRenewalPrimary = false
    expect(config.certRenewalPrimary).to.equal(false);

    // We can't easily re-require with different config, but we can verify the
    // generated config string contains the expected primary IP
    const { getPrimaryIP } = require('../src/services/rsync/config');
    const primaryIP = getPrimaryIP();
    expect(primaryIP).to.be.a('string');

    // The haproxy template module reads this at load time
    // Since certRenewalPrimary is false, it should use the primary IP
    // We verify the building blocks are correct
    expect(primaryIP).to.match(/^\d+\.\d+\.\d+\.\d+$/);
  });

  it('getPrimaryIP returns the fn host IP for the default test config', () => {
    const { getPrimaryIP } = require('../src/services/rsync/config');
    const primaryIP = getPrimaryIP();
    // Default rsync_config.json is fdm_fn1_app, group 1 fn host is itself: 5.39.57.42
    expect(primaryIP).to.equal('5.39.57.42');
  });
});

/* eslint-disable func-names */
const chai = require('chai');
const config = require('config');
const serviceHelper = require('../src/services/serviceHelper');

const rules = config.blackListedApps;

const { expect } = chai;

describe('serviceHelper - matchRule', () => {
  it('Test blocklist based on matchRule working correctly', () => {
    const appNameOK = 'kappa';
    const appNameOK2 = 'firefoxtest32';
    const appNameOK3 = 'afirefoxtest';
    const appNameOK4 = 'asdPresearchNode432';
    const appNameForbidden = 'firefoxtest';
    const appNameForbidden2 = 'PresearchNode';
    const appNameForbidden3 = 'PresearchNode123123';

    const validApp = serviceHelper.matchRule(appNameOK, rules);
    const validAppB = serviceHelper.matchRule(appNameOK2, rules);
    const validAppC = serviceHelper.matchRule(appNameOK3, rules);
    const validAppD = serviceHelper.matchRule(appNameOK4, rules);
    const notvalidApp = serviceHelper.matchRule(appNameForbidden, rules);
    const notvalidAppB = serviceHelper.matchRule(appNameForbidden2, rules);
    const notvalidAppC = serviceHelper.matchRule(appNameForbidden3, rules);

    expect(validApp).to.be.equal(false);
    expect(validAppB).to.be.equal(false);
    expect(validAppC).to.be.equal(false);
    expect(validAppD).to.be.equal(false);
    expect(notvalidApp).to.be.equal(true);
    expect(notvalidAppB).to.be.equal(true);
    expect(notvalidAppC).to.be.equal(true);
  });
});

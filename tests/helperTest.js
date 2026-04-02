/* eslint-disable func-names */
const chai = require('chai');
const serviceHelper = require('../src/services/serviceHelper');

const { expect } = chai;

describe('serviceHelper - matchRule', () => {
  const rules = ['PresearchNode*', 'BrokerNode*', 'Folding*', 'corsanywhere', 'firefoxtest'];

  it('Test blocklist based on matchRule working correctly', () => {
    // Should NOT match (not in rules)
    expect(serviceHelper.matchRule('kappa', rules)).to.be.equal(false);
    expect(serviceHelper.matchRule('afirefoxtest', rules)).to.be.equal(false);
    expect(serviceHelper.matchRule('asdPresearchNode432', rules)).to.be.equal(false);

    // Should match (exact or wildcard)
    expect(serviceHelper.matchRule('firefoxtest', rules)).to.be.equal(true);
    expect(serviceHelper.matchRule('PresearchNode', rules)).to.be.equal(true);
    expect(serviceHelper.matchRule('PresearchNode123123', rules)).to.be.equal(true);
    expect(serviceHelper.matchRule('corsanywhere', rules)).to.be.equal(true);
    expect(serviceHelper.matchRule('FoldingAtHome', rules)).to.be.equal(true);
    expect(serviceHelper.matchRule('BrokerNode99', rules)).to.be.equal(true);
  });
});

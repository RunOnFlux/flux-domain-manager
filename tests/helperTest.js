/* eslint-disable func-names */
const chai = require('chai');
const serviceHelper = require('../src/services/serviceHelper');

const { expect } = chai;

describe('serviceHelper - runWithConcurrency', () => {
  it('runs tasks with concurrency limit', async () => {
    let running = 0;
    let maxRunning = 0;
    const results = [];

    const makeTask = (val, delay) => async () => {
      running += 1;
      if (running > maxRunning) maxRunning = running;
      await new Promise((r) => { setTimeout(r, delay); });
      running -= 1;
      results.push(val);
      return val;
    };

    const tasks = [
      makeTask(1, 50),
      makeTask(2, 50),
      makeTask(3, 50),
      makeTask(4, 50),
      makeTask(5, 50),
    ];

    const settled = await serviceHelper.runWithConcurrency(tasks, 2);
    expect(maxRunning).to.be.at.most(2);
    expect(settled).to.have.lengthOf(5);
    expect(settled.every((r) => r.status === 'fulfilled')).to.equal(true);
  });

  it('handles task failures without stopping others', async () => {
    const tasks = [
      () => Promise.resolve('ok'),
      () => Promise.reject(new Error('fail')),
      () => Promise.resolve('also ok'),
    ];

    const settled = await serviceHelper.runWithConcurrency(tasks, 2);
    expect(settled).to.have.lengthOf(3);
    expect(settled[0].status).to.equal('fulfilled');
    expect(settled[1].status).to.equal('rejected');
    expect(settled[2].status).to.equal('fulfilled');
  });
});

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

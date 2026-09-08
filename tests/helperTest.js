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

  // The failing task must SETTLE FIRST, and that is the whole test.
  //
  // Promise.race rejects as soon as any promise it is watching rejects, and this
  // function awaited it bare - so one failure threw out of the loop, every task
  // not yet started never ran, and the promises already created were left with
  // no handler, which by default takes the process down.
  //
  // With an already-resolved task ahead of the failing one, the race settles on
  // THAT and the bug never shows: the previous version of this test put
  // `Promise.resolve('ok')` first and passed against the broken implementation.
  // A delayed first task is what puts the rejection at the front of the race.
  it('reports a failing task instead of aborting the batch', async () => {
    const tasks = [
      () => new Promise((r) => { setTimeout(() => r('ok'), 20); }),
      () => Promise.reject(new Error('fail')),
      () => Promise.resolve('also ok'),
      () => Promise.resolve('started after the failure'),
    ];

    const settled = await serviceHelper.runWithConcurrency(tasks, 2);
    expect(settled).to.have.lengthOf(4);
    expect(settled.map((r) => r.status)).to.deep.equal(['fulfilled', 'rejected', 'fulfilled', 'fulfilled']);
    // The tasks queued behind the failure still ran.
    expect(settled[3].value).to.equal('started after the failure');
  });

  // A thunk that throws before returning a promise never became one, so it
  // unwound this function on the spot rather than being reported.
  it('reports a task that throws synchronously', async () => {
    const settled = await serviceHelper.runWithConcurrency(
      [() => { throw new Error('sync'); }, () => Promise.resolve('after')],
      2,
    );
    expect(settled[0].status).to.equal('rejected');
    expect(settled[1].value).to.equal('after');
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

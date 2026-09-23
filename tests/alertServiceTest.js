/* eslint-disable func-names */
const chai = require('chai');
const { createAlerter } = require('../src/services/alertService');

const { expect } = chai;

function harness({ webhookUrl = 'https://discord.test/hook', failPost = false } = {}) {
  const posts = [];
  let clock = 0;
  const alerter = createAlerter({
    webhookUrl,
    identity: 'fdm-test app2.runonflux.io',
    now: () => clock,
    post: async (url, body) => {
      if (failPost) throw new Error('429 Too Many Requests');
      posts.push({ url, body });
    },
  });
  return {
    alerter,
    posts,
    advance: (ms) => { clock += ms; },
  };
}

describe('alertService', () => {
  it('sends once when a condition starts and nothing while it continues', async () => {
    const { alerter, posts } = harness();
    expect(await alerter.raise('spec-refused', 'refused 0 specs')).to.equal(true);
    expect(await alerter.raise('spec-refused', 'refused 0 specs')).to.equal(false);
    expect(await alerter.raise('spec-refused', 'refused 0 specs')).to.equal(false);
    expect(posts).to.have.lengthOf(1);
    expect(posts[0].url).to.equal('https://discord.test/hook');
    expect(posts[0].body.content).to.equal('[fdm-test app2.runonflux.io] PROBLEM spec-refused: refused 0 specs');
  });

  it('sends one recovery with duration and count, and a new incident alerts again', async () => {
    const { alerter, posts, advance } = harness();
    await alerter.raise('haproxy-reload', 'worker still serving');
    advance(90_000);
    await alerter.raise('haproxy-reload', 'worker still serving');
    expect(await alerter.resolve('haproxy-reload')).to.equal(true);
    expect(posts[1].body.content).to.equal('[fdm-test app2.runonflux.io] RESOLVED haproxy-reload after 90s, 2 occurrence(s)');

    expect(await alerter.resolve('haproxy-reload')).to.equal(false);
    await alerter.raise('haproxy-reload', 'again');
    expect(posts).to.have.lengthOf(3);
  });

  it('waits for afterCount occurrences', async () => {
    const { alerter, posts } = harness();
    await alerter.raise('haproxy-reload', 'x', { afterCount: 3 });
    await alerter.raise('haproxy-reload', 'x', { afterCount: 3 });
    expect(posts).to.have.lengthOf(0);
    await alerter.raise('haproxy-reload', 'x', { afterCount: 3 });
    expect(posts).to.have.lengthOf(1);
  });

  it('waits until a condition has lasted afterMs, and a transient one sends nothing at all', async () => {
    const { alerter, posts, advance } = harness();
    await alerter.raise('spec-refused', 'x', { afterMs: 120_000 });
    advance(30_000);
    await alerter.raise('spec-refused', 'x', { afterMs: 120_000 });
    expect(await alerter.resolve('spec-refused')).to.equal(false);
    expect(posts).to.have.lengthOf(0);

    await alerter.raise('spec-refused', 'x', { afterMs: 120_000 });
    advance(120_000);
    await alerter.raise('spec-refused', 'x', { afterMs: 120_000 });
    expect(posts).to.have.lengthOf(1);
  });

  it('keeps conditions independent by key', async () => {
    const { alerter, posts } = harness();
    await alerter.raise('config-refused:G', 'g');
    await alerter.raise('config-refused:nonG', 'n');
    await alerter.resolve('config-refused:G');
    expect(posts.map((p) => p.body.content.split(' ')[2])).to.deep.equal(['PROBLEM', 'PROBLEM', 'RESOLVED']);
  });

  it('truncates to the Discord content limit', async () => {
    const { alerter, posts } = harness();
    await alerter.raise('haproxy-reload', 'x'.repeat(5_000));
    expect(posts[0].body.content).to.have.lengthOf(2_000);
  });

  it('sends nothing without a webhook, and never throws when the post fails', async () => {
    const silent = harness({ webhookUrl: '' });
    expect(await silent.alerter.raise('spec-refused', 'x')).to.equal(false);
    expect(silent.posts).to.have.lengthOf(0);

    const failing = harness({ failPost: true });
    expect(await failing.alerter.raise('spec-refused', 'x')).to.equal(false);
  });
});

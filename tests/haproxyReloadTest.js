/* eslint-disable func-names */
const chai = require('chai');
const {
  parseWorkerPid, parseBindFailures, reloadAndVerify, formatFailure,
} = require('../src/services/haproxyReload');

const { expect } = chai;

// A reload whose worker could not bind two frontends, in the form haproxy 2.9
// writes it to the journal.
const BIND_FAILURE_JOURNAL = [
  '[NOTICE]   (1234) : Reloading HAProxy',
  '[ALERT]    (7) : Binding [/etc/haproxy/haproxy.cfg:6000] for frontend tcp_app_40005: cannot bind socket (Address already in use) for [0.0.0.0:40005]',
  '[ALERT]    (7) : Binding [/etc/haproxy/haproxy.cfg:6016] for frontend tcp_app_40010: cannot bind socket (Address already in use) for [0.0.0.0:40010]',
  '[ALERT]    (7) : [haproxy.main()] Some protocols failed to start their listeners! Exiting.',
  '[WARNING]  (1234) : Loading failure!',
].join('\n');

const showInfo = (pid) => `Name: HAProxy\nVersion: 2.9.15\nPid: ${pid}\nProcess_num: 1\n`;

/**
 * A fake shell: `show info` answers with the PIDs in turn (the last one
 * repeats), everything else from `responses`, matched by substring.
 */
function fakeRun({ pids, responses = {}, reloadThrows = null }) {
  const calls = [];
  let pidIndex = 0;
  const run = async (command) => {
    calls.push(command);
    if (command.includes('show info')) {
      const pid = pids[Math.min(pidIndex, pids.length - 1)];
      pidIndex += 1;
      if (pid === null) throw new Error('connect: no such file');
      return showInfo(pid);
    }
    if (command.includes('service haproxy reload') && reloadThrows) throw new Error(reloadThrows);
    const key = Object.keys(responses).find((k) => command.includes(k));
    return key ? responses[key] : '';
  };
  return { run, calls };
}

function deps(run) {
  let clock = 1_700_000_000_000;
  return {
    run,
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    timeoutMs: 15_000,
    pollMs: 500,
  };
}

describe('haproxyReload', () => {
  it('reads the worker PID from show info', () => {
    expect(parseWorkerPid(showInfo(4242))).to.equal(4242);
    expect(parseWorkerPid('')).to.equal(null);
    expect(parseWorkerPid(undefined)).to.equal(null);
  });

  it('reads every port haproxy could not bind', () => {
    expect(parseBindFailures(BIND_FAILURE_JOURNAL)).to.deep.equal([40005, 40010]);
    expect(parseBindFailures('[ALERT] something else')).to.deep.equal([]);
  });

  it('is verified when a different worker answers', async () => {
    const { run } = fakeRun({ pids: [100, 100, 100, 200] });
    const result = await reloadAndVerify(deps(run));
    expect(result).to.deep.equal({ ok: true, pid: 200 });
  });

  it('fails when the old worker is still serving at the deadline, naming each held port and its holder', async () => {
    const { run, calls } = fakeRun({
      pids: [100],
      responses: {
        journalctl: BIND_FAILURE_JOURNAL,
        StatusText: 'Reload failed!\n',
        'sport = :40005': 'ESTAB 0 0 10.0.0.1:40005 10.0.0.9:443 users:(("node",pid=77,fd=21))\n',
      },
    });
    const result = await reloadAndVerify(deps(run));

    expect(result.ok).to.equal(false);
    expect(result.reason).to.equal('worker 100 still serving 15s after reload');
    expect(result.statusText).to.equal('Reload failed!');
    expect(result.alerts).to.have.lengthOf(3);
    expect(result.holders).to.deep.equal([
      { port: 40005, holder: 'ESTAB 0 0 10.0.0.1:40005 10.0.0.9:443 users:(("node",pid=77,fd=21))' },
      { port: 40010, holder: 'no socket holds it now' },
    ]);
    expect(calls.filter((c) => c.includes('show info')).length).to.be.greaterThan(20);

    const text = formatFailure(result);
    expect(text).to.include('port 40005 held by: ESTAB');
    expect(text).to.include('Some protocols failed to start their listeners');
    expect(text).to.include('haproxy.cfg on disk is the config that failed');
  });

  it('fails without polling when the reload command itself fails', async () => {
    const { run, calls } = fakeRun({ pids: [100], reloadThrows: 'Job for haproxy.service failed' });
    const result = await reloadAndVerify(deps(run));
    expect(result.ok).to.equal(false);
    expect(result.reason).to.equal('reload command failed: Job for haproxy.service failed');
    expect(calls.filter((c) => c.includes('show info'))).to.have.lengthOf(1);
  });

  it('fails when haproxy is not answering at all', async () => {
    const { run } = fakeRun({ pids: [null] });
    const result = await reloadAndVerify(deps(run));
    expect(result.ok).to.equal(false);
    expect(result.reason).to.equal('worker none still serving 15s after reload');
  });

  it('is verified when haproxy starts answering after a reload found none', async () => {
    const { run } = fakeRun({ pids: [null, null, 300] });
    const result = await reloadAndVerify(deps(run));
    expect(result).to.deep.equal({ ok: true, pid: 300 });
  });
});

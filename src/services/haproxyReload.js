/**
 * Reloads haproxy and establishes whether the new worker actually took over.
 *
 * `service haproxy reload` is not evidence: ExecReload runs a syntax check and
 * signals the master, and exits 0 whether or not the new worker loads. A worker
 * that fails to bind any listener aborts, and the old worker keeps serving the
 * old config. What changes on success is the worker answering on the admin
 * socket, so a reload is verified by that worker's PID changing.
 */
const ADMIN_SOCKET = '/run/haproxy/admin.sock';

/**
 * @param {string} showInfo output of `show info`
 * @returns {number|null}
 */
function parseWorkerPid(showInfo) {
  const match = /^Pid:\s*(\d+)/m.exec(showInfo || '');
  return match ? Number(match[1]) : null;
}

/**
 * Ports haproxy reported it could not bind, from its ALERT lines, e.g.
 * `Binding [...] for frontend tcp_app_35126: cannot bind socket (Address already
 * in use) for [0.0.0.0:35126]`.
 *
 * @param {string} text
 * @returns {number[]}
 */
function parseBindFailures(text) {
  const pattern = /cannot bind socket \([^)]*\) for \[[^\]]*:(\d+)\]/g;
  const ports = Array.from((text || '').matchAll(pattern), (match) => Number(match[1]));
  return [...new Set(ports)];
}

async function readWorkerPid(run) {
  try {
    const output = await run(`echo "show info" | sudo socat ${ADMIN_SOCKET} -`);
    return parseWorkerPid(output);
  } catch {
    return null;
  }
}

async function runOr(run, command, fallback) {
  try {
    const output = await run(command);
    return output || fallback;
  } catch {
    return fallback;
  }
}

/**
 * What a failed reload looked like: haproxy's own ALERT lines, systemd's status
 * text, and for every port haproxy could not bind, the socket holding it.
 */
async function describeFailure(run, reloadStartedAtMs) {
  const since = Math.floor(reloadStartedAtMs / 1000) - 1;
  const journal = await runOr(run, `sudo journalctl -u haproxy --since @${since} --no-pager -o cat`, '');
  const alerts = journal.split('\n').filter((line) => line.includes('[ALERT]'));
  const statusText = (await runOr(run, 'systemctl show haproxy -p StatusText --value', '')).trim();

  const holders = await Promise.all(parseBindFailures(alerts.join('\n')).map(async (port) => {
    const holder = (await runOr(run, `sudo ss -Htanp '( sport = :${port} )'`, '')).trim();
    return { port, holder: holder || 'no socket holds it now' };
  }));

  return { alerts, statusText, holders };
}

/**
 * @param {{
 *   run: (command: string) => Promise<string>,
 *   sleep: (ms: number) => Promise<void>,
 *   now: () => number,
 *   timeoutMs: number,
 *   pollMs: number,
 * }} deps
 * @returns {Promise<{ ok: true, pid: number } | {
 *   ok: false, reason: string, alerts: string[], statusText: string,
 *   holders: { port: number, holder: string }[],
 * }>}
 */
async function reloadAndVerify(deps) {
  const {
    run, sleep, now, timeoutMs, pollMs,
  } = deps;

  const pidBefore = await readWorkerPid(run);
  const startedAt = now();

  let reloadError = null;
  try {
    await run('sudo service haproxy reload');
  } catch (error) {
    reloadError = error.message;
  }

  if (!reloadError) {
    const deadline = startedAt + timeoutMs;
    while (now() < deadline) {
      // eslint-disable-next-line no-await-in-loop
      const pid = await readWorkerPid(run);
      if (pid !== null && pid !== pidBefore) return { ok: true, pid };
      // eslint-disable-next-line no-await-in-loop
      await sleep(pollMs);
    }
  }

  const reason = reloadError
    ? `reload command failed: ${reloadError}`
    : `worker ${pidBefore ?? 'none'} still serving ${Math.round(timeoutMs / 1000)}s after reload`;
  const failure = await describeFailure(run, startedAt);
  return { ok: false, reason, ...failure };
}

/**
 * One line per fact, for the log and the alert.
 */
function formatFailure(result) {
  const lines = [result.reason];
  if (result.statusText) lines.push(`systemd: ${result.statusText}`);
  result.holders.forEach(({ port, holder }) => lines.push(`port ${port} held by: ${holder}`));
  result.alerts.slice(0, 10).forEach((line) => lines.push(line));
  if (result.alerts.length > 10) lines.push(`... ${result.alerts.length - 10} more ALERT lines`);
  lines.push('haproxy.cfg on disk is the config that failed; the old worker serves the previous one');
  return lines.join('\n');
}

module.exports = {
  parseWorkerPid,
  parseBindFailures,
  reloadAndVerify,
  formatFailure,
};

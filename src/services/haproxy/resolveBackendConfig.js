// Normalize one route config into the concrete haproxy backend directives to render,
// collapsing the legacy-vs-v9 trichotomy in a single place so the renderer stays
// version-blind:
//
//   field undefined  -> legacy: the haproxy-historical default (25s/20s server timeout,
//                       FDMSERVERID cookie when >1 backend, `check inter 3s ...`, no maxconn)
//   field present     -> v9 tunable, use the owner's value
//   toggle null       -> v9 feature OFF
//   toggle object     -> v9 feature ON with the owner's values
//
// Legacy and v9 emit genuinely different directive TEXT for the same feature (the
// sticky cookie and the retry block especially), so this resolves each into the final
// formatted lines rather than forcing a single shape. The renderer concatenates what
// it returns and never inspects a version.
//
// v9 fields are carried onto the route config by buildRouteConfigs off the resolved
// loadBalancing entry; a legacy route carries none, so `balancing === undefined` is the
// discriminator. Scope: backend-scoped directives only. `scheme`/`timeouts.httpRequest`
// (frontend) and `drain` (needs per-replica state) are resolved elsewhere.

// One backend-level directive line (no indentation — the renderer adds it).
const line = (text) => text;

function resolveBalanceLines(app, mode) {
  // Legacy: an explicit customConfig balance directive wins; otherwise round-robin
  // with the FDMSERVERID affinity cookie when there is more than one backend (http
  // only). v9: the owner's algorithm, with the v9 cookie when sticky sessions are on.
  if (app.balancing === undefined) {
    if (app.loadBalance) return [app.loadBalance.replace(/^\n {2}/, '')];
    if (mode === 'tcp') return [];
    const lines = [line('balance roundrobin')];
    // Counted over servers in rotation, not node addresses: two co-located replicas are
    // two servers on one node and do need the affinity cookie, and a draining server is
    // not a rotation target. With one server per node and nothing draining — every
    // legacy app — this is the historical `ips.length > 1`.
    if (app.servers.filter((s) => !s.draining).length > 1) {
      lines.push(line('cookie FDMSERVERID insert preserve indirect nocache maxlife 8h'));
    }
    return lines;
  }
  const lines = [line(`balance ${app.balancing}`)];
  if (app.stickySessions) {
    const ss = app.stickySessions;
    lines.push(line(`cookie ${ss.cookieName} insert indirect nocache maxidle ${ss.maxIdle} maxlife ${ss.maxLife}`));
  }
  return lines;
}

function resolveHealthCheckLines(app) {
  // Legacy: the customConfig probe directives verbatim. v9: an HTTP probe when
  // healthCheck is on, nothing when it is off (bare TCP connect check on the server).
  if (app.balancing === undefined) return app.healthcheck || [];
  const hc = app.healthCheck;
  if (!hc) return [];
  const lines = [
    line(`option httpchk ${hc.method} ${hc.path}`),
    line(`http-check expect status ${hc.expectedStatus}`),
  ];
  // An owner can narrow the check to the body as well as the status. haproxy evaluates
  // the two expect rules independently, so both must pass. Absent unless asked for.
  if (hc.expectString) lines.push(line(`http-check expect string ${hc.expectString}`));
  return lines;
}

function resolveOnceLines(app) {
  // Backend timeouts + retries, emitted once (only when the backend has servers).
  if (app.balancing === undefined) {
    const lines = [];
    lines.push(line(`timeout http-request ${app.timeout || '15s'}`));
    if (app.timeout) lines.push(line(`timeout server ${app.timeout}`));
    else lines.push(line(`timeout server ${app.syncFirst ? '20s' : '25s'}`));
    lines.push(line('retries 3'));
    lines.push(line('retry-on conn-failure response-timeout empty-response 500'));
    lines.push(line('option redispatch 1'));
    return lines;
  }
  const t = app.timeouts;
  const r = app.retries;
  const lines = [
    line(`timeout connect ${t.connect}`),
    line(`timeout server ${t.server}`),
    line(`timeout tunnel ${t.tunnel}`),
    // The shared :80/:443 frontends serve every app, so a per-app http-request timeout
    // has to live on the backend, not the frontend.
    line(`timeout http-request ${t.httpRequest}`),
    line(`retries ${r.count}`),
  ];
  if (r.retryOn && r.retryOn.length) lines.push(line(`retry-on ${r.retryOn.join(' ')}`));
  if (r.redispatch) lines.push(line('option redispatch'));
  return lines;
}

// Per-server health-check timing. v9 gives a bare `check` (the backend httpchk drives
// the probe) plus the owner's interval/rise/fall when enabled; legacy carries its
// fixed timing inline on the server line.
function resolveServerTiming(app, isV9) {
  if (!isV9) return 'inter 3s fall 2 rise 2 fastinter 500';
  const hc = app.healthCheck;
  return hc ? `inter ${hc.interval} rise ${hc.rise} fall ${hc.fall}` : '';
}

// TLS to the backend: legacy is app.ssl (verify none); v9 is backendTls with its verify mode.
function resolveServerSsl(app, isV9) {
  if (!isV9) return app.ssl ? 'ssl verify none' : '';
  return app.backendTls ? `ssl verify ${app.backendTls.verify}` : '';
}

function resolveBackendConfig(app, mode) {
  const isV9 = app.balancing !== undefined;
  return {
    isV9,
    mode,
    // Backend-level directives, in emit order after `mode`.
    balanceLines: resolveBalanceLines(app, mode),
    headerLines: app.headers || [],
    healthCheckLines: resolveHealthCheckLines(app),
    // Emitted once, only when the backend has at least one server.
    onceLines: resolveOnceLines(app),
    // Per-server rendering inputs.
    serverCheck: app.check,
    serverTiming: resolveServerTiming(app, isV9),
    serverConfig: isV9 ? '' : (app.serverConfig || ''),
    serverEnableH2: isV9 ? false : Boolean(app.enableH2),
    serverSsl: resolveServerSsl(app, isV9),
    serverMaxconn: isV9 ? `maxconn ${app.maxConnectionsPerServer}` : '',
    // The per-server affinity cookie source (null = no affinity).
    stickyV9: isV9 ? app.stickySessions : null,
  };
}

module.exports = { resolveBackendConfig };

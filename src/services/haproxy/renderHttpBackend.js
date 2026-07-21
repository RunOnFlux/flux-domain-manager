// Render a haproxy HTTP backend block from a resolved v9 loadBalancing entry.
//
// The entry is the fully-resolved (haproxy, http) provider from DeploymentSpec:
// tunables materialized (timeouts, retries, maxConnectionsPerServer), toggles either
// null (off) or a populated object (on), and hostPort merged per port. This renders
// the backend only; the frontend ACL/redirect (and the frontend-scoped
// timeout http-request, from timeouts.httpRequest) are the caller's concern.
//
// servers: [{ name, host, port }] — one per routable endpoint (per-replica under
// co-location), names already made unique by the caller.

const INDENT = '  ';

function renderHttpBackend({ backendName, servers, lb }) {
  const out = [`backend ${backendName}`, `${INDENT}mode http`, `${INDENT}balance ${lb.balancing}`];

  // Timeouts — backend-scoped connect/server/tunnel. httpRequest is frontend-scoped.
  out.push(`${INDENT}timeout connect ${lb.timeouts.connect}`);
  out.push(`${INDENT}timeout server ${lb.timeouts.server}`);
  out.push(`${INDENT}timeout tunnel ${lb.timeouts.tunnel}`);

  // Retries.
  out.push(`${INDENT}retries ${lb.retries.count}`);
  if (lb.retries.retryOn && lb.retries.retryOn.length) {
    out.push(`${INDENT}retry-on ${lb.retries.retryOn.join(' ')}`);
  }
  if (lb.retries.redispatch) out.push(`${INDENT}option redispatch`);

  // Sticky sessions — cookie insertion (on) vs no affinity (null).
  const sticky = lb.stickySessions;
  if (sticky) {
    out.push(`${INDENT}cookie ${sticky.cookieName} insert indirect nocache maxidle ${sticky.maxIdle} maxlife ${sticky.maxLife}`);
  }

  // Health check — HTTP probe (on) vs bare TCP connect (null).
  const hc = lb.healthCheck;
  if (hc) {
    out.push(`${INDENT}option httpchk ${hc.method} ${hc.path}`);
    out.push(`${INDENT}http-check expect status ${hc.expectedStatus}`);
  }

  // Server lines.
  for (const srv of servers) {
    const parts = [`${INDENT}server ${srv.name} ${srv.host}:${srv.port}`, 'check'];
    if (hc) parts.push(`inter ${hc.interval} rise ${hc.rise} fall ${hc.fall}`);
    parts.push(`maxconn ${lb.maxConnectionsPerServer}`);
    if (lb.backendTls) parts.push('ssl verify none');
    if (sticky) parts.push(`cookie ${srv.name}`);
    out.push(parts.join(' '));
  }

  return out.join('\n');
}

module.exports = { renderHttpBackend };

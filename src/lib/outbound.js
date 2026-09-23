/**
 * Every outbound connection FDM makes is created here, and nowhere else (lint
 * enforces it for src/).
 *
 * The reason is the balancer's own listeners. haproxy binds each app's TCP
 * frontend with SO_REUSEADDR, and Linux lets such a listener bind a port that a
 * non-listening socket holds only when that socket also set SO_REUSEADDR. A
 * socket without it - in any state, TIME_WAIT included - makes the bind fail,
 * and one failed bind fails the whole haproxy reload.
 *
 * Node has no setsockopt. libuv sets SO_REUSEADDR whenever it binds a socket, and
 * Node binds a client socket when it is given `localAddress`. `0.0.0.0` lets the
 * kernel pick the source address exactly as it would for an unbound socket. The
 * port is then chosen at bind time, so these sockets share one ephemeral pool
 * rather than one per destination.
 *
 * An IPv4 bind cannot reach an IPv6 address (EINVAL), so name resolution is
 * restricted to A records.
 */
const http = require('node:http');
const https = require('node:https');
const axios = require('axios');

const SOCKET_POLICY = Object.freeze({ localAddress: '0.0.0.0', family: 4 });

// Node's own global agent settings, so pooling behaves as it did on the default
// agent: reuse a connection, drop it after 5s idle.
const AGENT_DEFAULTS = Object.freeze({ keepAlive: true, timeout: 5_000, scheduling: 'lifo' });

const HARD_STOP = Symbol('hardStop');

/**
 * @param {{ ca?: Buffer, cert?: Buffer, key?: Buffer, rejectUnauthorized?: boolean }} [tls]
 */
function createAgents(tls = {}) {
  return {
    httpAgent: new http.Agent({ ...AGENT_DEFAULTS, ...SOCKET_POLICY }),
    httpsAgent: new https.Agent({ ...AGENT_DEFAULTS, ...tls, ...SOCKET_POLICY }),
  };
}

/**
 * An axios instance whose connections carry SOCKET_POLICY.
 *
 * A request's `timeout` bounds the wait for a response; the request is aborted
 * outright at twice that.
 *
 * @param {{
 *   baseURL?: string,
 *   timeoutMs?: number,
 *   headers?: Object,
 *   tls?: { ca?: Buffer, cert?: Buffer, key?: Buffer, rejectUnauthorized?: boolean },
 * }} [options]
 * @returns {import('axios').AxiosInstance}
 */
function createHttpClient(options = {}) {
  const {
    baseURL, timeoutMs, headers, tls,
  } = options;

  const client = axios.create({
    baseURL,
    timeout: timeoutMs,
    headers,
    ...createAgents(tls),
  });

  // axios' own timeout does not cover a socket that stalls after the headers.
  // The hard stop is cleared when the request settles, so a burst of probes does
  // not leave one live timer each behind it.
  client.interceptors.request.use((requestConfig) => {
    const cfg = requestConfig;
    if (cfg.timeout && !cfg.signal) {
      const controller = new AbortController();
      const hardStopMs = cfg.timeout * 2;
      const timer = setTimeout(() => controller.abort(new Error(`aborted after ${hardStopMs}ms`)), hardStopMs);
      timer.unref();
      cfg.signal = controller.signal;
      cfg[HARD_STOP] = timer;
    }
    return cfg;
  });
  const clearHardStop = (cfg) => { if (cfg && cfg[HARD_STOP]) clearTimeout(cfg[HARD_STOP]); };
  client.interceptors.response.use(
    (response) => { clearHardStop(response.config); return response; },
    (error) => { clearHardStop(error.config); return Promise.reject(error); },
  );

  return client;
}

/** Socket options for MongoClient, which accepts them as client options. */
const MONGO_SOCKET_OPTIONS = SOCKET_POLICY;

module.exports = {
  SOCKET_POLICY,
  MONGO_SOCKET_OPTIONS,
  createHttpClient,
};

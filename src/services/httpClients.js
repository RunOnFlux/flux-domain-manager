/**
 * The outbound HTTP clients shared across modules, one per purpose. Clients that
 * carry their own credentials (Cloudflare, PowerDNS, the decrypt service) are
 * built where those credentials are read.
 */
const { createHttpClient } = require('../lib/outbound');

// api.runonflux.io and its explorer.
const fluxApi = createHttpClient();
const explorer = createHttpClient();

// Flux nodes and the apps on them. Callers pass their own per-request timeout.
const nodeChecks = createHttpClient();

// App endpoints that serve self-signed certificates.
const nodeChecksSelfSigned = createHttpClient({ tls: { rejectUnauthorized: false } });

// Public "what is my address" services.
const ipLookup = createHttpClient({ timeoutMs: 13_456 });

module.exports = {
  fluxApi,
  explorer,
  nodeChecks,
  nodeChecksSelfSigned,
  ipLookup,
};

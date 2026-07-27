// FDM fetches an app's backend-TLS CA over the same mTLS channel it uses to decrypt
// sealed specs. The CA is derived per-app and is byte-deterministic across the fleet, so
// the PEM returned here is stable for a given app name — a caller may cache it and treat
// the on-disk write as idempotent. The transport is injected so the fetch can be exercised
// without the mTLS client (which reads key material off disk).

/**
 * Request an app's backend-TLS CA certificate from the crypto service.
 * @param {{
 *   http: import('axios').AxiosInstance,
 *   endpoint: string,
 *   appName: string,
 * }} deps
 * @returns {Promise<string>} the CA certificate in PEM
 */
async function requestCaCertificate({ http, endpoint, appName }) {
  const response = await http.get(endpoint, { params: { appName } });
  if (response.status !== 200) {
    throw new Error(`crypto service HTTP ${response.status} fetching CA for ${appName}`);
  }
  const { status, certificate } = response.data;
  if (status !== 'ok' || !certificate) {
    throw new Error(`crypto service rejected CA request for ${appName}`);
  }
  return certificate;
}

module.exports = { requestCaCertificate };

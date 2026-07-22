// Normalize one route config's edge exposure — how the domain is served at :80/:443
// and whether FDM obtains a certificate — collapsing the legacy-vs-v9 split in one
// place so the frontend/cert code stays version-blind. The backend-scoped analog is
// resolveBackendConfig; this resolves the frontend/cert-scoped concerns (v9 `scheme`
// and `managedCertificates`).
//
//   scheme undefined  -> legacy: terminate TLS, redirect http->https, FDM-managed cert
//                        (the historical behaviour for every legacy custom domain)
//   scheme present     -> v9: the owner's declared scheme
//
// The four v9 schemes, and what each means at the edge:
//   httpsRedirect   terminate TLS at :443, redirect :80 -> https      (default)
//   httpsOnly       terminate TLS at :443, deny plain http on :80
//   httpOnly        serve plain http on :80, no TLS, no cert
//   httpPassthrough pass raw TLS through to the backend (FDM never terminates), no cert
//
// `needsCert` gates the certbot path: FDM obtains a cert only when it terminates AND
// the route is managed (v9 non-managed = owner points DNS themselves; legacy = always
// managed). Platform FQDNs never carry a scheme, so they always resolve to the legacy
// default here — FDM owns app2.runonflux.io and its certificate.

const SCHEMES = {
  httpsRedirect: { terminates: true, passthrough: false, httpPolicy: 'redirect' },
  httpsOnly: { terminates: true, passthrough: false, httpPolicy: 'deny' },
  httpOnly: { terminates: false, passthrough: false, httpPolicy: 'serve' },
  httpPassthrough: { terminates: false, passthrough: true, httpPolicy: 'redirect' },
};

/**
 * @param {Object} app a route config (carries `scheme`/`managedCertificates` for v9;
 *   both absent/legacy default on a legacy route or a platform-FQDN entry)
 * @returns {{
 *   scheme: string, terminates: boolean, passthrough: boolean,
 *   httpPolicy: 'redirect'|'deny'|'serve', needsCert: boolean,
 * }}
 */
function resolveRouteExposure(app) {
  const isLegacy = app.scheme === undefined;
  const scheme = isLegacy ? 'httpsRedirect' : app.scheme;
  const rule = SCHEMES[scheme] || SCHEMES.httpsRedirect;
  // Legacy always manages its cert; v9 carries the owner's toggle.
  const managed = isLegacy ? true : Boolean(app.managedCertificates);
  return {
    scheme,
    terminates: rule.terminates,
    passthrough: rule.passthrough,
    httpPolicy: rule.httpPolicy,
    needsCert: rule.terminates && managed,
  };
}

module.exports = { resolveRouteExposure };

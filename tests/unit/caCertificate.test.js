// The CA fetch rides the same mTLS transport as spec decryption. Here the transport is a
// stub so the request shape (endpoint + appName query) and the fail-closed response
// handling are exercised without the mTLS client. A backend that answers 200 does not mean
// success: the crypto service signals failure with a body-level status, and an app that is
// not entitled to `verify: required` must never render a ca-file it could not fetch.
const { expect } = require('chai');
const { requestCaCertificate } = require('../../src/services/flux/caCertificate');

const PEM = '-----BEGIN CERTIFICATE-----\nMIIB...\n-----END CERTIFICATE-----\n';
const ENDPOINT = 'v2/caCertificate';

describe('requestCaCertificate — CA fetch over a stub transport', () => {
  it('GETs the configured endpoint with the appName query and returns the PEM', async () => {
    let seen = null;
    const http = {
      get: async (url, opts) => {
        seen = { url, opts };
        return { status: 200, data: { status: 'ok', certificate: PEM } };
      },
    };

    const cert = await requestCaCertificate({ http, endpoint: ENDPOINT, appName: 'myapp' });

    expect(cert).to.equal(PEM);
    expect(seen.url).to.equal(ENDPOINT);
    expect(seen.opts).to.deep.equal({ params: { appName: 'myapp' } });
  });

  it('throws when the crypto service reports a body-level error (fails closed)', async () => {
    const http = { get: async () => ({ status: 200, data: { status: 'error' } }) };

    let threw = false;
    try {
      await requestCaCertificate({ http, endpoint: ENDPOINT, appName: 'myapp' });
    } catch (e) {
      threw = true;
    }
    expect(threw).to.equal(true);
  });

  it('throws when status is ok but no certificate is present', async () => {
    const http = { get: async () => ({ status: 200, data: { status: 'ok' } }) };

    let threw = false;
    try {
      await requestCaCertificate({ http, endpoint: ENDPOINT, appName: 'myapp' });
    } catch (e) {
      threw = true;
    }
    expect(threw).to.equal(true);
  });

  it('throws on a non-200 HTTP status', async () => {
    const http = { get: async () => ({ status: 503, data: {} }) };

    let threw = false;
    try {
      await requestCaCertificate({ http, endpoint: ENDPOINT, appName: 'myapp' });
    } catch (e) {
      threw = true;
    }
    expect(threw).to.equal(true);
  });
});

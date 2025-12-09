const endpoint = ''; // DNS Gateway API endpoint
const certPath = ''; // mTLS client certificate
const keyPath = ''; // mTLS client private key
const caPath = ''; // mTLS CA certificate
const timeout = 30000; // Request timeout in milliseconds
const enabled = false; // Enable or disable DNS Gateway integration

module.exports = {
  endpoint,
  certPath,
  keyPath,
  caPath,
  timeout,
  enabled,
};

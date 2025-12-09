const endpoint = ''; // DNS Gateway API endpoint
const certPath = ''; // mTLS client certificate
const keyPath = ''; // mTLS client private key
const caPath = ''; // mTLS CA certificate
const timeout = 30000; // Request timeout in milliseconds
const enabled = false; // Enable or disable DNS Gateway integration
const deletionGracePeriodMs = 60 * 60 * 1000; // Wait 1 hour before deleting DNS for removed apps (protects against FDM restart/API issues)

module.exports = {
  endpoint,
  certPath,
  keyPath,
  caPath,
  timeout,
  enabled,
  deletionGracePeriodMs,
};

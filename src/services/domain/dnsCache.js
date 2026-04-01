const log = require('../../lib/log');

// In-memory DNS failure cache. Resets on process restart.
// Maps domain -> { failures: number, lastChecked: number (epoch ms) }
const cache = new Map();

// Backoff buckets:
// 1-3 failures:  always check (DNS might be propagating)
// 4-10 failures: skip if checked within 1 hour
// 11-50 failures: skip if checked within 6 hours
// 51+: skip if checked within 24 hours
const BACKOFF_BUCKETS = [
  { maxFailures: 3, cooldownMs: 0 },
  { maxFailures: 10, cooldownMs: 60 * 60 * 1000 },
  { maxFailures: 50, cooldownMs: 6 * 60 * 60 * 1000 },
  { maxFailures: Infinity, cooldownMs: 24 * 60 * 60 * 1000 },
];

function shouldCheckDomain(domain) {
  const entry = cache.get(domain);
  if (!entry) return true;

  const now = Date.now();
  const bucket = BACKOFF_BUCKETS.find((b) => entry.failures <= b.maxFailures);
  if (!bucket) return true;

  if (bucket.cooldownMs === 0) return true;
  return (now - entry.lastChecked) >= bucket.cooldownMs;
}

function recordFailure(domain) {
  const entry = cache.get(domain) || { failures: 0, lastChecked: 0 };
  entry.failures += 1;
  entry.lastChecked = Date.now();
  cache.set(domain, entry);

  const bucket = BACKOFF_BUCKETS.find((b) => entry.failures <= b.maxFailures);
  const cooldownMin = Math.round((bucket ? bucket.cooldownMs : 0) / 60000);
  if (entry.failures === 4 || entry.failures === 11 || entry.failures === 51) {
    log.info(`DNS for ${domain} failed ${entry.failures} times, next check in ${cooldownMin}m`);
  }
}

function recordSuccess(domain) {
  cache.delete(domain);
}

function getCacheSize() {
  return cache.size;
}

module.exports = {
  shouldCheckDomain,
  recordFailure,
  recordSuccess,
  getCacheSize,
};

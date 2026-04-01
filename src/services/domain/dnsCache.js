const log = require('../../lib/log');

// In-memory DNS failure cache. Resets on process restart.
// Maps domain -> { failures: number, lastChecked: number (epoch ms) }
const cache = new Map();

const MIN_COOLDOWN_MS = 15 * 60 * 1000; // 15 minutes (match cycle interval)
const MAX_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24 hours

// Exponential backoff: 15m, 30m, 1h, 2h, 4h, 8h, 16h, 24h (capped)
function getCooldownMs(failures) {
  if (failures <= 1) return 0; // first failure, always recheck next cycle
  const ms = MIN_COOLDOWN_MS * (2 ** (failures - 2));
  return Math.min(ms, MAX_COOLDOWN_MS);
}

function shouldCheckDomain(domain) {
  const entry = cache.get(domain);
  if (!entry) return true;

  const cooldown = getCooldownMs(entry.failures);
  if (cooldown === 0) return true;
  return (Date.now() - entry.lastChecked) >= cooldown;
}

function recordFailure(domain) {
  const entry = cache.get(domain) || { failures: 0, lastChecked: 0 };
  entry.failures += 1;
  entry.lastChecked = Date.now();
  cache.set(domain, entry);

  const cooldownMin = Math.round(getCooldownMs(entry.failures) / 60000);
  if (entry.failures <= 5 || entry.failures % 10 === 0) {
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
  getCooldownMs,
};

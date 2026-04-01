const log = require('../../lib/log');

// In-memory DNS failure cache. Resets on process restart.
// Maps domain -> { failures: number, lastChecked: number (epoch ms) }
const cache = new Map();

const MAX_COOLDOWN_MS = 2 * 60 * 60 * 1000; // 2 hours

// Backoff: 0, 30m, 1h, 2h (capped)
// A new misconfigured domain gets 4 checks in ~2 hours, then every 2h after
const COOLDOWNS_MS = [
  0,                      // failure 1: recheck next cycle
  30 * 60 * 1000,         // failure 2: 30m
  60 * 60 * 1000,         // failure 3: 1h
];

function getCooldownMs(failures) {
  if (failures <= 0) return 0;
  if (failures <= COOLDOWNS_MS.length) return COOLDOWNS_MS[failures - 1];
  return MAX_COOLDOWN_MS;
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

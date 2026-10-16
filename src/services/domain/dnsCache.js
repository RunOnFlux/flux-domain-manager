'use strict';

const { ConditionLog } = require('../conditionLog');

// In-memory DNS failure cache. Resets on process restart.
// Maps domain -> { failures: number, lastChecked: number (epoch ms) }
const cache = new Map();

const MAX_COOLDOWN_MS = 2 * 60 * 60 * 1000; // 2 hours

// Backoff: 0, 30m, 1h, 2h (capped)
// A new misconfigured domain gets 4 checks in ~2 hours, then every 2h after
const COOLDOWNS_MS = [
  0, // failure 1: recheck next cycle
  30 * 60 * 1000, // failure 2: 30m
  60 * 60 * 1000, // failure 3: 1h
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

const unpointed = new ConditionLog({ level: 'info' });

function recordFailure(domain) {
  const entry = cache.get(domain) || { failures: 0, lastChecked: 0 };
  entry.failures += 1;
  entry.lastChecked = Date.now();
  cache.set(domain, entry);

  unpointed.report(domain, true, () => `DNS for ${domain} does not point here; rechecking with backoff`);
}

function recordSuccess(domain) {
  cache.delete(domain);
  unpointed.report(domain, false, () => `DNS for ${domain} does not point here`);
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

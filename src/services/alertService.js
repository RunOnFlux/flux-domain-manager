/**
 * Operator alerts, posted to a Discord webhook.
 *
 * A condition is identified by a key. `raise` records an occurrence; the first
 * message is sent once the condition has occurred `afterCount` times and has
 * lasted `afterMs`, and nothing more is sent while it continues. `resolve` ends
 * it, with one message if the first was sent. Every occurrence is logged.
 *
 * Posting never throws and is never awaited by callers' control flow. With no
 * webhook URL configured, alerts are log lines only.
 */
const os = require('node:os');
const config = require('config');
const log = require('../lib/log');
const { createHttpClient } = require('../lib/outbound');

// Discord rejects message content over 2,000 characters.
const DISCORD_MAX_CONTENT = 2_000;

function formatDuration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 120) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 120) return `${m}m`;
  return `${Math.round(m / 60)}h`;
}

/**
 * @param {{
 *   webhookUrl: string,
 *   identity: string,
 *   post?: (url: string, body: Object) => Promise<unknown>,
 *   now?: () => number,
 * }} options
 */
function createAlerter(options) {
  const { webhookUrl, identity } = options;
  const now = options.now || Date.now;
  const post = options.post || (() => {
    const client = createHttpClient({ timeoutMs: 5_000 });
    return (url, body) => client.post(url, body);
  })();

  /** @type {Map<string, { firstAt: number, count: number, sent: boolean }>} */
  const conditions = new Map();

  function send(text) {
    if (!webhookUrl) return Promise.resolve(false);
    const content = `[${identity}] ${text}`.slice(0, DISCORD_MAX_CONTENT);
    return Promise.resolve()
      .then(() => post(webhookUrl, { content }))
      .then(() => true)
      .catch((error) => {
        log.error(`Discord alert not delivered: ${error.message}`);
        return false;
      });
  }

  /**
   * @param {string} key
   * @param {string} message
   * @param {{ afterCount?: number, afterMs?: number }} [when]
   * @returns {Promise<boolean>} whether a message was delivered
   */
  function raise(key, message, when = {}) {
    const { afterCount = 1, afterMs = 0 } = when;
    const at = now();

    let condition = conditions.get(key);
    if (!condition) {
      condition = { firstAt: at, count: 0, sent: false };
      conditions.set(key, condition);
    }
    condition.count += 1;

    log.warn(`[alert ${key}] ${message}`);

    if (condition.sent || condition.count < afterCount || at - condition.firstAt < afterMs) {
      return Promise.resolve(false);
    }
    condition.sent = true;
    return send(`PROBLEM ${key}: ${message}`);
  }

  /**
   * @param {string} key
   * @param {string} [message]
   * @returns {Promise<boolean>} whether a message was delivered
   */
  function resolve(key, message) {
    const condition = conditions.get(key);
    if (!condition) return Promise.resolve(false);
    conditions.delete(key);

    const lasted = formatDuration(now() - condition.firstAt);
    log.info(`[alert ${key}] resolved after ${lasted}, ${condition.count} occurrence(s)`);

    if (!condition.sent) return Promise.resolve(false);
    const suffix = message ? `: ${message}` : '';
    return send(`RESOLVED ${key} after ${lasted}, ${condition.count} occurrence(s)${suffix}`);
  }

  return { raise, resolve };
}

const alerter = createAlerter({
  webhookUrl: config.alerts.discordWebhookUrl,
  identity: `${os.hostname()} ${config.fdmAppDomain}`,
});

module.exports = {
  createAlerter,
  raise: alerter.raise,
  resolve: alerter.resolve,
};

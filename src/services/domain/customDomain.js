const config = require('config');
const log = require('../../lib/log');

const MAX_NAME_LENGTH = 253;
const MAX_LABEL_LENGTH = 63;
const LABEL_CHARS = /^[a-z0-9-]+$/;
const HAS_LETTER = /[a-z]/;

/**
 * A DNS hostname in its lowercase ASCII form: at most 253 characters, at least
 * two labels, each label 1-63 of `a-z 0-9 -` with no hyphen at either end, and
 * a last label that is not all digits. Checked label by label rather than with
 * one regex, so the cost is linear in the input whatever it contains.
 *
 * @param {string} name
 * @returns {boolean}
 */
function isHostname(name) {
  if (typeof name !== 'string' || name.length === 0 || name.length > MAX_NAME_LENGTH) return false;
  const labels = name.split('.');
  if (labels.length < 2) return false;
  const valid = labels.every((label) => label.length <= MAX_LABEL_LENGTH
    && LABEL_CHARS.test(label)
    && !label.startsWith('-')
    && !label.endsWith('-'));
  return valid && HAS_LETTER.test(labels[labels.length - 1]);
}

/**
 * The hostname a single custom-domain entry names, or null when it names none.
 * A scheme, a path and a trailing dot are removed and a leading `www.` is
 * dropped, because FDM adds the `www.` and `test.` variants itself. A name
 * inside Flux's own app zone is never a custom domain.
 *
 * @param {string} entry one comma-separated part of a spec's `domains` value
 * @returns {string|null}
 */
function parseCustomDomain(entry) {
  let name = entry.trim().toLowerCase();
  if (name.startsWith('https://')) name = name.slice('https://'.length);
  else if (name.startsWith('http://')) name = name.slice('http://'.length);
  const slash = name.indexOf('/');
  if (slash !== -1) name = name.slice(0, slash);
  if (name.endsWith('.')) name = name.slice(0, -1);
  if (name.startsWith('www.')) name = name.slice('www.'.length);
  if (!isHostname(name)) return null;
  const appZone = `${config.appSubDomain}.${config.mainDomain}`;
  if (name === appZone || name.endsWith(`.${appZone}`)) return null;
  return name;
}

const reportedRejections = new Set();

/**
 * The hostnames a spec's per-port `domains` value names, in order and without
 * duplicates. Every entry that names no hostname is dropped, so the rest of the
 * app is still served; one that contains a dot is logged once per app and value.
 *
 * @param {unknown} value the spec's `domains[i]` for one port
 * @param {string} appName for the log line
 * @returns {string[]}
 */
function parseCustomDomains(value, appName) {
  if (typeof value !== 'string') return [];
  const hostnames = [];
  value.split(',').forEach((entry) => {
    if (!entry.includes('.')) return;
    const hostname = parseCustomDomain(entry);
    if (hostname === null) {
      const key = `${appName}\u0000${entry}`;
      if (!reportedRejections.has(key)) {
        reportedRejections.add(key);
        log.warn(`Ignoring custom domain ${JSON.stringify(entry.slice(0, 300))} of ${appName}: not a valid hostname`);
      }
    } else if (!hostnames.includes(hostname)) {
      hostnames.push(hostname);
    }
  });
  return hostnames;
}

module.exports = {
  isHostname,
  parseCustomDomain,
  parseCustomDomains,
};

const crypto = require('crypto');
const fs = require('fs');
// eslint-disable-next-line no-restricted-modules -- address parsing only, no connections
const net = require('net');
const config = require('config');
const log = require('../../lib/log');
const { fixedCustomDomains, isHostname, parseCustomDomains } = require('../domain/customDomain');

// An absolute path haproxy reads as a single word: no whitespace, quotes, `#`
// or anything else its config syntax gives a meaning to.
const CA_FILE = /^\/[A-Za-z0-9._/-]+$/;
const BRACKETED = /^\[([^\]]+)\](?::\d{1,5})?$/;
const PORT = /^\d{1,5}$/;
const PEM_CERTIFICATE = /-----BEGIN CERTIFICATE-----[^-]*-----END CERTIFICATE-----/g;
const PEM_BEGIN = /-----BEGIN /g;

const reported = new Set();

/**
 * Logs a message the first time it comes up, so a problem that lasts is not
 * repeated on every pass. A changed message is logged again.
 *
 * @param {'error'|'warn'|'info'} level
 * @param {string} message
 */
function reportOnce(level, message) {
  if (reported.has(message)) return;
  if (reported.size >= 1000) reported.clear();
  reported.add(message);
  log[level](message);
}

/** Forgets what reportOnce has logged. For tests. */
function resetReports() {
  reported.clear();
}

/**
 * The address an instance ip or an allow-list entry names, spelled one way:
 * `a.b.c.d` for `a.b.c.d` and `a.b.c.d:port`, and the compressed lowercase
 * form for `ipv6`, `[ipv6]` and `[ipv6]:port`. null when it names none.
 *
 * @param {unknown} entry
 * @returns {string|null}
 */
function addressOf(entry) {
  if (typeof entry !== 'string') return null;
  const bracketed = BRACKETED.exec(entry);
  let host = entry;
  if (bracketed) {
    [, host] = bracketed;
  } else if (!net.isIPv6(entry)) {
    const parts = entry.split(':');
    if (parts.length > 2) return null;
    [host] = parts;
  }
  if (net.isIPv4(host)) return host;
  if (!net.isIPv6(host)) return null;
  try {
    return new URL(`http://[${host}]/`).hostname.slice(1, -1);
  } catch (error) {
    return null;
  }
}

function isPort(value) {
  return (typeof value === 'number' || typeof value === 'string')
    && PORT.test(String(value)) && +value >= 1 && +value <= 65535;
}

/**
 * Whether an app's settings leave it off: an object whose `enabled` is false
 * or not given. Anything else is on, or a problem that is treated as on.
 *
 * @param {unknown} settings
 * @returns {boolean}
 */
function isOff(settings) {
  return Boolean(settings) && typeof settings === 'object' && !Array.isArray(settings)
    && (settings.enabled === false || settings.enabled === undefined);
}

/**
 * Why haproxy could not load a CA file, or null when it can: it has to be a
 * regular file that holds PEM certificates and nothing else, at least one,
 * each of which parses. haproxy refuses a whole config whose CA file is
 * missing, empty, not PEM (DER, say), a directory or unreadable, every other
 * app's backends with it, so such a file must never reach the config.
 *
 * @param {string} caFile an absolute path
 * @returns {string|null}
 */
function caFileProblem(caFile) {
  let pem;
  try {
    if (!fs.statSync(caFile).isFile()) return 'caFile (not a file)';
    pem = fs.readFileSync(caFile, 'latin1');
  } catch (error) {
    return error.code === 'ENOENT' || error.code === 'ENOTDIR' ? 'caFile (no such file)' : 'caFile (unreadable)';
  }
  const certificates = pem.match(PEM_CERTIFICATE) || [];
  if (!certificates.length) return 'caFile (no PEM certificate)';
  if ((pem.match(PEM_BEGIN) || []).length !== certificates.length) return 'caFile (not only PEM certificates)';
  try {
    certificates.forEach((certificate) => new crypto.X509Certificate(certificate));
  } catch (error) {
    return 'caFile (a certificate that does not parse)';
  }
  return null;
}

/**
 * Why the settings of an app that is on cannot be used, or null when they can.
 * The CA file is read only once there is an address to reach: before that,
 * no server line names it.
 *
 * @param {unknown} settings
 * @param {(path: string) => string|null} checkCaFile caFileProblem, or a stand-in
 * @returns {string|null}
 */
function settingsProblem(settings, checkCaFile) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return 'settings';
  const {
    enabled, caFile, verifyHost, port, allowedIps,
  } = settings;
  if (enabled !== true) return 'enabled';
  if (typeof caFile !== 'string' || !CA_FILE.test(caFile) || caFile.split('/').includes('..')) return 'caFile';
  if (!isHostname(verifyHost)) return 'verifyHost';
  if (!isPort(port)) return 'port';
  if (!Array.isArray(allowedIps)) return 'allowedIps';
  if (!allowedIps.every((ip) => typeof ip === 'string' && net.isIP(ip) && addressOf(ip))) return 'allowedIps';
  return allowedIps.length ? checkCaFile(caFile) : null;
}

/**
 * The apps of the `verifiedTlsApps` config that are on, by lowercase name.
 * Each maps to `{ caFile, verifyHost, port, allowed }`, `allowed` being the
 * addresses its instances may be reached on with their position in
 * `allowedIps`, or to `{ problem }` when its settings cannot be used. An app
 * whose settings say `enabled: false`, or do not say `enabled`, is off and not
 * in the map: FDM handles it as any other app. Anything else is on, so an app
 * whose settings cannot be read gets no servers rather than unverified ones.
 * Only a value that is not a map of apps at all is refused outright: there is
 * no telling which apps it meant to protect.
 *
 * @param {unknown} configured the `verifiedTlsApps` config value
 * @param {(path: string) => string|null} [checkCaFile] why a CA file cannot be used, or null
 * @returns {Map<string, Object>}
 */
function resolveVerifiedTlsApps(configured, checkCaFile = caFileProblem) {
  const resolved = new Map();
  if (configured === undefined || configured === null) return resolved;
  if (typeof configured !== 'object' || Array.isArray(configured)) {
    throw new Error('verifiedTlsApps must map app names to their settings');
  }
  const byName = new Map();
  Object.entries(configured).forEach(([key, settings]) => {
    const name = key.toLowerCase();
    byName.set(name, [...(byName.get(name) || []), settings]);
  });
  byName.forEach((listed, name) => {
    if (listed.every(isOff)) return;
    if (listed.length > 1) {
      resolved.set(name, { problem: 'listed more than once' });
      return;
    }
    const [settings] = listed;
    const problem = settingsProblem(settings, checkCaFile);
    if (problem) {
      resolved.set(name, { problem });
      return;
    }
    const allowed = new Map();
    settings.allowedIps.forEach((ip, i) => {
      const address = addressOf(ip);
      if (!allowed.has(address)) allowed.set(address, i);
    });
    resolved.set(name, {
      caFile: settings.caFile,
      verifyHost: settings.verifyHost,
      port: +settings.port,
      allowed,
    });
  });
  return resolved;
}

/**
 * Whether an app is on in a `verifiedTlsApps` config value. A value that is
 * not a map of apps answers false here; the render refuses it.
 *
 * @param {unknown} configured the `verifiedTlsApps` config value
 * @param {string} name the app's name
 * @returns {boolean}
 */
function isVerifiedTlsApp(configured, name) {
  try {
    return typeof name === 'string' && resolveVerifiedTlsApps(configured, () => null).has(name.toLowerCase());
  } catch (error) {
    return false;
  }
}

/**
 * The haproxy server options of a verified app: TLS whose certificate has to
 * chain to the app's CA and name its verifyHost, which is also the SNI sent,
 * for traffic and health checks alike.
 *
 * @param {{ caFile: string, verifyHost: string }} verifiedTls
 * @returns {string}
 */
function verifiedServerOptions({ caFile, verifyHost }) {
  return `ssl verify required ca-file ${caFile} verifyhost ${verifyHost} sni str(${verifyHost}) check-sni ${verifyHost}`;
}

/**
 * The domains reserved for a verified app: those FDM gives it itself (its
 * fixed custom domains with their `www.` and `test.` variants, and its main
 * domain in the app zone), and every domain its entries carry.
 *
 * @param {string} name lowercase app name
 * @param {Object[]} own the app's entries
 * @param {string} appZone `<appSubDomain>.<mainDomain>`
 * @returns {Set<string>}
 */
function reservedDomains(name, own, appZone) {
  const domains = new Set([`${name}.${appZone}`]);
  parseCustomDomains(fixedCustomDomains(name), name).forEach((domain) => {
    [domain, `www.${domain}`, `test.${domain}`].forEach((variant) => domains.add(variant));
  });
  own.forEach((entry) => domains.add(entry.domain));
  return domains;
}

/**
 * The servers of one entry of a verified app: only the instances on its
 * allow-list, in their existing order, each with a name that does not give
 * its address away (`allowed<n>`, n its position in allowedIps). That name is
 * also its sticky cookie, so neither /fluxstatistics nor a client's cookie
 * shows where an instance runs. A second instance on one address gets
 * `allowed<n>-2` and so on.
 *
 * @param {string[]} ips
 * @param {Map<string, number>} allowed
 * @returns {{ ips: string[], ids: Map<string, string> }}
 */
function allowedServers(ips, allowed) {
  const kept = [];
  const ids = new Map();
  const perAddress = new Map();
  ips.forEach((ip) => {
    const position = allowed.get(addressOf(ip));
    if (position === undefined || ids.has(ip)) return;
    const count = (perAddress.get(position) || 0) + 1;
    perAddress.set(position, count);
    ids.set(ip, count === 1 ? `allowed${position}` : `allowed${position}-${count}`);
    kept.push(ip);
  });
  return { ips: kept, ids };
}

/**
 * The entries as the config renders them once the verified apps are applied.
 *
 * For an app that is on:
 * - its domains are its own: an entry of any other app for one of them is left
 *   out, whatever the ownership check said, and a domain two verified apps
 *   claim goes to neither;
 * - every one of its entries points at its configured `port` and shares one
 *   backend, and that backend's servers are only the instances on its
 *   allow-list, reached over TLS it verifies (`verifiedTls`);
 * - with no allowed instance, settings that cannot be used, or a `port` that
 *   is not one of its ports, its entries keep their domains with no ips at
 *   all, and haproxy answers 503. So does an `isRdata` entry whose first
 *   instance, its primary, is not allowed: a replica is never made primary.
 *
 * Every other entry is returned as it is; with no app on, the list itself.
 * Problems are logged once.
 *
 * @param {Object[]} entries configured-app entries
 * @param {Map<string, Object>} verified from resolveVerifiedTlsApps
 * @param {string} [appZone] `<appSubDomain>.<mainDomain>`
 * @returns {Object[]}
 */
function applyVerifiedTls(entries, verified, appZone = `${config.appSubDomain}.${config.mainDomain}`) {
  if (!verified.size) return entries;
  const nameOf = (entry) => String(entry.name).toLowerCase();

  // Who each reserved domain belongs to; null for a domain two verified apps claim.
  const owners = new Map();
  const apps = new Map();
  verified.forEach((settings, name) => {
    const own = entries.filter((entry) => nameOf(entry) === name);
    apps.set(name, { settings, own });
    reservedDomains(name, own, appZone).forEach((domain) => {
      owners.set(domain, owners.has(domain) && owners.get(domain) !== name ? null : name);
    });
  });

  // Why an app that is on gets no servers at all, if it gets none.
  const problems = new Map();
  apps.forEach(({ settings, own }, name) => {
    if (settings.problem) {
      problems.set(name, `invalid verifiedTlsApps ${settings.problem}`);
      return;
    }
    const ports = [...new Set(own.map((entry) => +entry.port))];
    if (own.length && !ports.includes(settings.port)) {
      problems.set(name, `verifiedTlsApps port ${settings.port} is not one of its ports (${ports.join(', ')})`);
    }
  });
  problems.forEach((problem, name) => reportOnce('error', `${name}: ${problem}; its backends get no servers`));

  const rendered = [];
  entries.forEach((entry) => {
    const name = nameOf(entry);
    const owner = owners.get(entry.domain);
    if (owner === null) {
      reportOnce('error', `Leaving ${entry.domain} of ${entry.name} out: more than one verified app claims it`);
      return;
    }
    if (owner !== undefined && owner !== name) {
      reportOnce('warn', `Leaving ${entry.domain} of ${entry.name} out: it belongs to the verified app ${owner}`);
      return;
    }
    const app = apps.get(name);
    if (!app) {
      rendered.push(entry);
      return;
    }
    if (problems.has(name)) {
      rendered.push({ ...entry, ips: [] });
      return;
    }
    const { settings } = app;
    // A replicated database's first instance is its primary and the rest its
    // backups; without the primary, keeping a backup would make it primary.
    const primaryLeftOut = entry.isRdata && entry.ips.length > 0 && !settings.allowed.has(addressOf(entry.ips[0]));
    const { ips, ids } = primaryLeftOut ? { ips: [], ids: new Map() } : allowedServers(entry.ips, settings.allowed);
    if (primaryLeftOut) {
      reportOnce('warn', `${entry.name}: its primary instance is not on the verifiedTlsApps allow-list; its backends get no servers, so that no replica becomes primary`);
    } else if (!ips.length) {
      reportOnce('warn', `${entry.name}: none of its ${entry.ips.length} instances is on the verifiedTlsApps allow-list; its backends get no servers`);
    } else if (ips.length < entry.ips.length) {
      reportOnce('info', `${entry.name}: ${entry.ips.length - ips.length} of its ${entry.ips.length} instances are not on the verifiedTlsApps allow-list and are left out`);
    }
    rendered.push({
      ...entry,
      appName: `${name}_${settings.port}`,
      port: settings.port,
      ips,
      verifiedTls: { caFile: settings.caFile, verifyHost: settings.verifyHost, ids },
    });
  });
  return rendered;
}

module.exports = {
  addressOf,
  applyVerifiedTls,
  isVerifiedTlsApp,
  reportOnce,
  resetReports,
  resolveVerifiedTlsApps,
  verifiedServerOptions,
};

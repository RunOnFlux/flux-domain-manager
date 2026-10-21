const dns = require('dns').promises;
const log = require('../../lib/log');

// Who gets a custom domain when two or more live apps claim it.
//
// 1. DNS, when it names one of the claimants: the domain's CNAME points at that
//    app's Flux domain (myapp.app.runonflux.io, myapp_30001.app2.runonflux.io),
//    or a TXT record at _flux.<domain> reads "flux-app=myapp". Only whoever
//    controls the domain can set either, so this beats any registration order.
// 2. Otherwise the app that put the domain in its spec first (lowest
//    permanent-message height) keeps it.
// Uncontested domains are never looked up and never withheld.
//
// addConfigurations binds a registered domain D as D, www.D and test.D, after
// cutting everything up to "www." off the registered value. Claims are compared on
// those bound names, not on the raw strings, otherwise registering www.victim.com,
// xwww.victim.com or test.victim.com would get around an earlier claim on
// victim.com: each is a different string, but each ends up routing a name the
// victim's app serves.

const DNS_TIMEOUT_MS = 5000;
const TXT_PREFIX = 'flux-app=';

// The domain addConfigurations binds for a registered value: the same transform
// step for step, then trimmed (haproxy reads " victim.com" as victim.com) and
// lower-cased (host names are case-insensitive).
function canonicalDomain(registered) {
  if (typeof registered !== 'string') return '';
  let domain = registered
    .replace('https://', '')
    .replace('http://', '')
    .replace(/[&/\\#,+()$~%'":*?<>{}]/g, '');
  if (domain.includes('www.')) {
    [, domain] = domain.split('www.');
  }
  return (domain || '').trim().toLowerCase();
}

// Every host name a registered domain ends up serving.
function boundNames(registered) {
  const domain = canonicalDomain(registered);
  return domain ? [domain, `www.${domain}`, `test.${domain}`] : [];
}

// Raw custom-domain values of an app spec, read the way addConfigurations reads
// them (one domains entry per port, comma-separated). An enterprise spec in a
// permanent message is encrypted and yields nothing.
function specDomains(spec) {
  if (!spec) return [];
  const components = spec.version <= 3 ? [{ ports: spec.ports, domains: spec.domains }] : spec.compose;
  const domains = [];
  (Array.isArray(components) ? components : []).forEach((component) => {
    const ports = Array.isArray(component?.ports) ? component.ports : [];
    const values = Array.isArray(component?.domains) ? component.domains : [];
    ports.forEach((port, i) => {
      if (typeof values[i] === 'string') domains.push(...values[i].split(','));
    });
  });
  return domains;
}

// The app a CNAME target is the Flux domain of, e.g. myapp_30001.app2.runonflux.io
// -> myapp. Null for anything that is not under `.${mainDomain}`.
function appFromFluxDomain(target, mainDomain) {
  const host = String(target || '').toLowerCase().replace(/\.$/, '');
  if (!mainDomain || !host.endsWith(`.${mainDomain.toLowerCase()}`)) return null;
  const [label] = host.split('.');
  return label.split('_')[0] || null;
}

function withTimeout(promise) {
  return Promise.race([
    promise,
    new Promise((resolve) => { setTimeout(resolve, DNS_TIMEOUT_MS, null); }),
  ]).catch(() => null);
}

function createDomainOwnership() {
  // bound name -> Set of live app names claiming it
  let claimsByName = new Map();
  // app name -> its permanent messages
  let messagesByApp = new Map();
  // `${appName}\n${name}` -> height of the first message claiming it, or null
  let claimHeights = new Map();
  // contested host -> the claimant its DNS names, or null when DNS names none
  let dnsOwners = new Map();

  // Height of the first permanent message in which `appName` claims `name`, or
  // null when no message shows the claim (e.g. an encrypted enterprise spec).
  function claimHeight(appName, name) {
    const key = `${appName}\n${name}`;
    if (claimHeights.has(key)) return claimHeights.get(key);
    let first = null;
    (messagesByApp.get(appName) || []).forEach((message) => {
      const { height } = message;
      if (typeof height !== 'number' || (first !== null && height >= first)) return;
      const claims = specDomains(message.appSpecifications)
        .some((registered) => boundNames(registered).includes(name));
      if (claims) first = height;
    });
    claimHeights.set(key, first);
    return first;
  }

  function contestedHosts() {
    return [...claimsByName].filter(([, claimants]) => claimants.size > 1).map(([host]) => host);
  }

  // Lower-cased app names the DNS of `host` points at: its CNAME target's Flux
  // domain and any _flux TXT record. Undefined when the lookups failed, so the
  // previous answer can be kept instead of flapping on a DNS hiccup.
  async function dnsNamedApps(host, { mainDomain, resolveCname, resolveTxt }) {
    const [cnames, txts] = await Promise.all([
      withTimeout(resolveCname(host).catch((error) => (error.code === 'ENODATA' || error.code === 'ENOTFOUND' ? [] : null))),
      withTimeout(resolveTxt(`_flux.${host}`).catch((error) => (error.code === 'ENODATA' || error.code === 'ENOTFOUND' ? [] : null))),
    ]);
    if (cnames === null && txts === null) return undefined;
    const named = new Set();
    (cnames || []).forEach((target) => {
      const app = appFromFluxDomain(target, mainDomain);
      if (app) named.add(app);
    });
    (txts || []).forEach((chunks) => {
      const record = chunks.join('').trim().toLowerCase();
      if (record.startsWith(TXT_PREFIX)) named.add(record.slice(TXT_PREFIX.length).trim());
    });
    return named;
  }

  return {
    // The current global app specs (enterprise ones decrypted). Only live apps
    // contend, so an expired app releases its domains.
    setLiveApps(specs) {
      claimsByName = new Map();
      [...(specs || [])].forEach((spec) => {
        if (!spec?.name) return;
        specDomains(spec).forEach((registered) => {
          boundNames(registered).forEach((name) => {
            if (!claimsByName.has(name)) claimsByName.set(name, new Set());
            claimsByName.get(name).add(spec.name);
          });
        });
      });
    },

    // The permanent-message ledger: [{ appSpecifications: { name, ... }, height }].
    setPermanentMessages(permanentMessages) {
      messagesByApp = new Map();
      claimHeights = new Map();
      (permanentMessages || []).forEach((message) => {
        const appName = message?.appSpecifications?.name;
        if (!appName) return;
        if (!messagesByApp.has(appName)) messagesByApp.set(appName, []);
        messagesByApp.get(appName).push(message);
      });
    },

    // Looks up the DNS of every contested host (only those) and records which
    // claimant, if exactly one, it names. www.D and test.D fall back to D's DNS,
    // since FDM serves them for D. Call after setLiveApps; ownsDomain stays
    // synchronous and reads the result.
    async refreshDnsOwners({
      mainDomain,
      resolveCname = (host) => dns.resolveCname(host),
      resolveTxt = (host) => dns.resolveTxt(host),
    } = {}) {
      const options = { mainDomain, resolveCname, resolveTxt };
      const hosts = contestedHosts();
      const lookups = new Map();
      const lookup = (host) => {
        if (!lookups.has(host)) lookups.set(host, dnsNamedApps(host, options));
        return lookups.get(host);
      };
      const next = new Map();
      await Promise.all(hosts.map(async (host) => {
        const claimants = new Map([...claimsByName.get(host)].map((name) => [name.toLowerCase(), name]));
        const pick = (named) => {
          const owners = [...(named || [])].filter((app) => claimants.has(app));
          return owners.length === 1 ? claimants.get(owners[0]) : null;
        };
        const own = await lookup(host);
        let owner = pick(own);
        const parent = host.replace(/^(www|test)\./, '');
        let failed = own === undefined;
        if (!owner && parent !== host) {
          const inherited = await lookup(parent);
          owner = pick(inherited);
          failed = failed || inherited === undefined;
        }
        if (!owner && failed && dnsOwners.has(host)) owner = dnsOwners.get(host);
        next.set(host, owner);
      }));
      dnsOwners = next;
    },

    // May `appName` get a backend for host `name` (a bound name: D, www.D or test.D)?
    // False only when DNS names another claimant, or when DNS names none and
    // another live app provably claimed the host earlier. When this app's own
    // claim cannot be dated it is not dropped, and the existing first-come dedup
    // decides, as before.
    ownsDomain(name, appName) {
      const host = typeof name === 'string' ? name.trim().toLowerCase() : '';
      const claimants = host ? claimsByName.get(host) : null;
      if (!claimants || claimants.size < 2 || !claimants.has(appName)) return true;
      try {
        // ignore an answer about a claimant that has since gone (refresh pending)
        const dnsOwner = dnsOwners.get(host);
        if (dnsOwner && claimants.has(dnsOwner)) {
          if (dnsOwner === appName) return true;
          log.warn(`Custom domain ${host} points at ${dnsOwner} in DNS, not routing it for ${appName}`);
          return false;
        }
        const ours = claimHeight(appName, host);
        if (ours === null) return true;
        const owner = [...claimants].find((other) => {
          if (other === appName) return false;
          const theirs = claimHeight(other, host);
          return theirs !== null && theirs < ours;
        });
        if (owner) {
          log.warn(`Custom domain ${host} is owned by ${owner}, not routing it for ${appName}`);
          return false;
        }
        return true;
      } catch (error) {
        // An authorisation check that breaks must not hand the domain out.
        log.error(`Custom domain ownership check failed for ${host} (${appName}): ${error.message}`);
        return false;
      }
    },
  };
}

module.exports = {
  canonicalDomain,
  boundNames,
  specDomains,
  appFromFluxDomain,
  createDomainOwnership,
};

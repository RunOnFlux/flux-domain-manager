const log = require('../../lib/log');

// First-registrant-wins protection for custom domains.
//
// When two or more live apps claim the same custom domain, the app that put it in
// its spec first (lowest permanent-message height) keeps it and the others do not
// get a backend for it.
//
// addConfigurations binds a registered domain D as D, www.D and test.D, after
// cutting everything up to "www." off the registered value. Claims are compared on
// those bound names, not on the raw strings, otherwise registering www.victim.com,
// xwww.victim.com or test.victim.com would get around an earlier claim on
// victim.com: each is a different string, but each ends up routing a name the
// victim's app serves.

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

function createDomainOwnership() {
  // bound name -> Set of live app names claiming it
  let claimsByName = new Map();
  // app name -> its permanent messages
  let messagesByApp = new Map();
  // `${appName}\n${name}` -> height of the first message claiming it, or null
  let claimHeights = new Map();

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

    // May `appName` get a backend for host `name` (a bound name: D, www.D or test.D)?
    // False only when another live app provably claimed it first. When this app's
    // own claim cannot be dated it is not dropped, and the existing first-come
    // dedup decides, as before.
    ownsDomain(name, appName) {
      const host = typeof name === 'string' ? name.trim().toLowerCase() : '';
      const claimants = host ? claimsByName.get(host) : null;
      if (!claimants || claimants.size < 2 || !claimants.has(appName)) return true;
      try {
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
  createDomainOwnership,
};

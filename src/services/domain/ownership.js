// First-registrant-wins protection for custom domains.
//
// When two or more currently-live apps claim the same custom domain, the app whose
// earliest permanent-message registration is oldest keeps it; the others do not route
// it. Only live apps contend: the claim registry is built from the current global app
// specifications, so an expired app drops out and releases the domain — nothing an app
// did while live can hold a domain once it is gone. The permanent-message ledger is
// used only to order the *current* claimants.

// Resolve one ownership question against a registry snapshot. Returns true when
// `appName` may serve `domain`, false when another live app owns it; fails open (true)
// when no owner can be established.
function resolveOwner(domain, appName, appDomains, permanentMessages) {
  if (!domain) return true;
  const target = domain.toLowerCase();

  const claimants = appDomains.filter((entry) => entry.fqdns.includes(target));
  const weClaim = claimants.some((entry) => entry.name === appName);
  // Uncontested (no other live app claims it) or not ours: nothing to arbitrate.
  if (claimants.length < 2 || !weClaim) return true;

  const claimantNames = claimants.map((entry) => entry.name);
  const registrations = permanentMessages
    .filter((message) => claimantNames.includes(message.appSpecifications?.name))
    .filter((message) => JSON.stringify(message).toLowerCase().includes(target))
    .sort((a, b) => a.height - b.height);

  const firstRegistrant = registrations[0];
  if (!firstRegistrant) return true; // no registration found — don't drop the domain
  return firstRegistrant.appSpecifications.name === appName;
}

// Holds the domain-ownership state — which live apps claim which domains, and the
// permanent-message ledger that orders them — and answers ownership queries. The
// fetcher feeds it (setAppDomains / setPermanentMessages); the route builder queries
// it (ownsDomain). Owning the state here keeps it out of module globals and makes
// ownership decisions unit-testable without standing up the fetch loop.
class DomainOwnershipRegistry {
  #appDomains = [];

  #permanentMessages = [];

  // Per-live-app claimed custom-domain FQDNs: [{ name, fqdns: [...] }].
  setAppDomains(appDomains) {
    this.#appDomains = appDomains || [];
  }

  // The permanent-message ledger: [{ appSpecifications: { name }, height }].
  setPermanentMessages(permanentMessages) {
    this.#permanentMessages = permanentMessages || [];
  }

  // True when `appName` may serve `domain`; false when another live app owns it.
  ownsDomain(domain, appName) {
    return resolveOwner(domain, appName, this.#appDomains, this.#permanentMessages);
  }
}

module.exports = { DomainOwnershipRegistry };

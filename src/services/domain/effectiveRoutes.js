// A handful of platform apps are served on domains FDM owns rather than the ones their
// spec declares — `cloud` answers on both runonflux.io and runonflux.com, `web` splits
// its front end across two names. That policy is FDM's, not the owner's, so it belongs
// here rather than in the spec.
//
// It used to be applied by rewriting the raw wire spec before anything read it
// (`for (const component of appSpecs.compose) component.domains = [...]`). That was
// version-shaped — v9 specs have no `compose`, so an app with a matching name threw, and
// it threw outside the per-app error handling, taking the whole batch of every app down
// with it. Applying the policy to the RESOLVED routes instead is version-blind by
// construction: every version normalizes onto routes, and no raw spec is touched.
//
// Reading routes through here rather than calling `deployment.routes()` directly is what
// keeps routing and certificates seeing the same domains.
const config = require('config');

/**
 * The app's routes with FDM's domain policy applied.
 *
 * A listed component's declared custom domains are REPLACED by the configured ones, which
 * attach to its first routed port; its remaining ports serve no custom domain. That
 * reproduces the per-component `domains` array the old wire rewrite built, where entry 0
 * belonged to port 0. `*` matches every component.
 *
 * @param {Object} deployment resolved DeploymentSpec
 * @returns {Array<Object>} routes, overridden where policy says so
 */
function effectiveRoutes(deployment) {
  const routes = deployment.routes();
  const overrides = config.domainOverrides[deployment.appName];
  if (!overrides) return routes;

  const componentSeen = new Set();
  return routes.map((route) => {
    const domains = overrides[route.componentName] || overrides['*'];
    if (!domains) return route;
    const isComponentsFirstPort = !componentSeen.has(route.componentName);
    componentSeen.add(route.componentName);
    return { ...route, customDomains: isComponentsFirstPort ? [...domains] : [] };
  });
}

module.exports = { effectiveRoutes };

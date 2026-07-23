// Deterministic driver for the config-generation characterization: feed a spec
// (or a list) through the version-blind backend-config builder and haproxy renderer
// with fixed inputs, so the exact output can be pinned as a golden. The rewrite must
// reproduce this byte-for-byte for the existing app population.
//
// Live FDM chooses backend IPs by querying app locations and health-checking
// them; that is non-deterministic and network-bound. Here the IPs are fixed, so
// the only thing that varies is the spec -> config transform under test.
const specLibs = require('../../../src/services/flux/specLibs');
const { buildRouteConfigs } = require('../../../src/services/haproxy/buildRouteConfigs');
const { createAppsHaproxyConfig } = require('../../../src/services/haproxyTemplate');
const { getUnifiedDomains, getCustomDomains } = require('../../../src/services/domain');

// Two nodes for the general case (exercises the multi-server cookie path), one
// node for single-live-instance apps (which route to a single backend). Real
// FDM ports (host:apiPort) so the server-line parsing is exercised.
const MULTI_NODE_IPS = ['144.76.10.20:16127', '167.86.90.30:16127'];
const SINGLE_NODE_IP = ['135.148.60.40:16127'];

// The per-component markers that today drive routing shape. `g:` pins traffic to
// a single live instance (active-standby); `r:` marks ordered/replica data so
// standbys render as backups. Mirrored here purely to feed the builder the same
// flags it gets in production.
function markerPresent(spec, marker) {
  const datas = spec.version <= 3
    ? [spec.containerData]
    : (spec.compose || []).map((comp) => comp.containerData || '');
  return datas.some((data) => typeof data === 'string' && data.includes(marker));
}

const routesToSingleInstance = (spec) => markerPresent(spec, 'g:');
const usesOrderedData = (spec) => markerPresent(spec, 'r:');

// Loose (unnamed) instances, which is every spec in the corpus and every app in the wild:
// one backend per node, all resolved off the declared view. Named replicas are the
// pinned-v9 case and are exercised by perReplicaRouting.test.js.
const looseBackends = (ips, drainingIps = []) => ips
  .map((ip) => ({ ip, replica: null, draining: false }))
  .concat(drainingIps.map((ip) => ({ ip, replica: null, draining: true })));
const looseDeployments = (deployment) => new Map([[null, deployment]]);

// The route configs one spec produces on its own, with fixed inputs. Sealed
// (still-encrypted) specs are decrypted before rendering in production, so they have
// no offline projection — return null and let the caller skip them. Ownership is not
// arbitrated here (no live registry), so every declared custom domain routes.
async function routeConfigsForSpec(spec) {
  const instance = await specLibs.deserialize(spec);
  if (instance.sealed) return null;
  const singleInstance = routesToSingleInstance(spec);
  const ips = singleInstance ? SINGLE_NODE_IP : MULTI_NODE_IPS;
  const deployment = await specLibs.resolveDeployment(instance, null);
  return buildRouteConfigs(looseDeployments(deployment), spec.name, looseBackends(ips), singleInstance, usesOrderedData(spec));
}

// The full haproxy config for a set of specs, assembled the way production does:
// single-instance apps last, so the frontend/backend ordering and the cross-app
// domain de-duplication are exercised end to end.
async function renderConfig(specs) {
  const generalRouteConfigs = [];
  const singleInstanceRouteConfigs = [];
  // eslint-disable-next-line no-restricted-syntax
  for (const spec of specs) {
    // eslint-disable-next-line no-await-in-loop
    const routeConfigs = await routeConfigsForSpec(spec);
    // eslint-disable-next-line no-continue
    if (!routeConfigs) continue; // sealed — decrypted before rendering in production
    (routesToSingleInstance(spec) ? singleInstanceRouteConfigs : generalRouteConfigs).push(...routeConfigs);
  }
  return createAppsHaproxyConfig(generalRouteConfigs.concat(singleInstanceRouteConfigs));
}

// The platform + cert-eligible custom domains one spec produces, version-blind off its
// resolved routes. Sealed specs are decrypted before this path in production, so they
// have no offline projection — characterized as a sealed marker.
async function domainsForSpec(spec) {
  const instance = await specLibs.deserialize(spec);
  if (instance.sealed) return { unifiedDomains: { __sealed: true }, customDomains: { __sealed: true } };
  const deployment = await specLibs.resolveDeployment(instance, null);
  return { unifiedDomains: getUnifiedDomains(deployment), customDomains: getCustomDomains(deployment) };
}

module.exports = {
  routeConfigsForSpec, domainsForSpec, renderConfig, looseBackends, looseDeployments,
};

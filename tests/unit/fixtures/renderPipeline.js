// Deterministic driver for the config-generation characterization: feed a spec
// (or a list) through the real backend-config builder and haproxy renderer with
// fixed inputs, so the exact output can be pinned as a golden. The rewrite must
// reproduce this byte-for-byte for the existing app population.
//
// Live FDM chooses backend IPs by querying app locations and health-checking
// them; that is non-deterministic and network-bound. Here the IPs are fixed, so
// the only thing that varies is the spec -> config transform under test.
const { addConfigurations } = require('../../../src/services/domainService');
const { createAppsHaproxyConfig } = require('../../../src/services/haproxyTemplate');

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

// The backend-config bag one spec produces on its own, with fixed inputs.
function bagForSpec(spec) {
  const singleInstance = routesToSingleInstance(spec);
  const app = { ...spec, isRdata: usesOrderedData(spec) };
  const ips = singleInstance ? SINGLE_NODE_IP : MULTI_NODE_IPS;
  const bag = [];
  addConfigurations(bag, app, ips, singleInstance);
  return bag;
}

// The full haproxy config for a set of specs, assembled the way production does:
// single-instance apps last, so the frontend/backend ordering and the cross-app
// domain de-duplication are exercised end to end.
function renderConfig(specs) {
  const generalBags = [];
  const singleInstanceBags = [];
  for (const spec of specs) {
    (routesToSingleInstance(spec) ? singleInstanceBags : generalBags).push(...bagForSpec(spec));
  }
  return createAppsHaproxyConfig(generalBags.concat(singleInstanceBags));
}

module.exports = { bagForSpec, renderConfig };

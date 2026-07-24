const config = require('config');
const serviceHelper = require('../serviceHelper');

function filterApps(apps) {
  const subsetConfig = config.subset;
  const { start, end } = subsetConfig;
  const startCode = start.charCodeAt(0);
  const endCode = end.charCodeAt(0);
  if (startCode > endCode) {
    throw new Error(`${start} is after ${end} lexicographically`);
  }

  const appsInBucket = [];
  // eslint-disable-next-line no-restricted-syntax
  for (const app of apps) {
    const charCode = app.name.toUpperCase().charCodeAt(0);
    if (charCode >= startCode && charCode <= endCode) {
      appsInBucket.push(app);
    }
  }

  return appsInBucket;
}

// Materialized up front: callers are handed Map iterators as well as arrays, and every
// return below must be an array — the routing loops both scan the result for the
// mandatory apps AND iterate it, and an iterator would be spent by the first pass.
function getApplicationsToProcess(apps) {
  let applicationsToProcess = [...apps];

  // if running apps for a specific owner
  if (config.ownersApps.length) {
    return applicationsToProcess.filter((appSpec) => config.ownersApps.includes(appSpec.owner));
  }

  // exclude not whitelisted apps
  if (config.whiteListedApps.length) {
    applicationsToProcess = applicationsToProcess.filter((app) => serviceHelper.matchRule(app.name, config.whiteListedApps));
  }
  // exclude blacklisted apps
  if (config.blackListedApps.length) {
    applicationsToProcess = applicationsToProcess.filter((app) => !serviceHelper.matchRule(app.name, config.blackListedApps));
  }

  if (!config.useSubset) {
    return applicationsToProcess;
  }

  return filterApps(applicationsToProcess);
}

module.exports = {
  getApplicationsToProcess,
};

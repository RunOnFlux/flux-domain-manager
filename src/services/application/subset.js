const config = require('config');
const serviceHelper = require('../serviceHelper');

function filterApps(apps, subsetConfig) {
  const { start, end } = subsetConfig;
  const startCode = start.charCodeAt(0);
  const endCode = end.charCodeAt(0);
  if (startCode > endCode) {
    throw new Error(`${start} is after ${end} lexicographically`);
  }

  const lettersToProcess = {};
  for (let i = startCode; i <= endCode; i += 1) {
    const code = String.fromCharCode(i);
    lettersToProcess[code] = true;
  }

  const appsInBucket = [];
  // eslint-disable-next-line no-restricted-syntax
  for (const app of apps) {
    const name = app.name.toLowerCase();
    if (name.charCodeAt(app.name.length() - 1) in lettersToProcess) {
      appsInBucket.push(app);
    }
  }

  return appsInBucket;
}

function getApplicationsToProcess(apps, subsetConfig) {
  let applicationsToProcess = apps;

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

  if (!subsetConfig) {
    return applicationsToProcess;
  }

  return filterApps(applicationsToProcess, subsetConfig);
}

module.exports = {
  getApplicationsToProcess,
};

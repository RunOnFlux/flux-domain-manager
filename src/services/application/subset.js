const config = require('config');
const { SHA1 } = require('crypto-js');
const { SUBSET_TYPE } = require('../constants');
const serviceHelper = require('../serviceHelper');

// Gets the first charater of the hashed name, and converts it into a bucket number
function getBucket(appName) {
  const hashedName = SHA1(appName).toString();
  return (hashedName.charCodeAt(0) % config.subset.config.total);
}

// Filtering function for getting applications that reside in this bucket
function getAppsInThisBucket(applications, bucket) {
  // IF bucket is set as 0, we run fdm for all applications
  if (bucket === 0) {
    return applications;
  }

  const appsInBucket = [];
  // eslint-disable-next-line no-restricted-syntax
  for (const app of applications) {
    if (getBucket(app.name) === bucket) {
      appsInBucket.push(app);
    }
  }

  return appsInBucket;
}

function getApplicationsToProcess(apps, subsetConfig) {
  const totalAppsLength = apps.length;
  let applicationsToProcess = apps;
  // exclude not whitelisted apps
  if (config.whiteListedApps.length) {
    applicationsToProcess = applicationsToProcess.filter((app) => serviceHelper.matchRule(app.name, config.whiteListedApps));
  }
  // exclude blacklisted apps
  if (config.blackListedApps.length) {
    applicationsToProcess = applicationsToProcess.filter((app) => !serviceHelper.matchRule(app.name, config.blackListedApps));
  }

  if (config.ownersApps.length) {
    applicationsToProcess = applicationsToProcess.filter((appSpec) => config.ownersApps.includes(appSpec.owner));
  }

  if (!subsetConfig) {
    return applicationsToProcess;
  }

  switch (subsetConfig.type) {
    case SUBSET_TYPE.BUCKET:
      applicationsToProcess = getAppsInThisBucket(applicationsToProcess, subsetConfig.config.bucket);
      break;
    case SUBSET_TYPE.APPLICATION:
      applicationsToProcess = subsetConfig.config.applicationConfig;
      break;
    default:
  }

  console.log(`Total: ${totalAppsLength}, After Apps Subset Filtering: ${applicationsToProcess.length}`);
  return applicationsToProcess;
}

module.exports = {
  getBucket,
  getApplicationsToProcess,
};

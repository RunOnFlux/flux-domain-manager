// Regenerate the characterization golden from the CURRENT FDM code + committed
// fixtures. The golden is the exact output the config-generation rewrite must
// reproduce for every representative spec. Run intentionally after a *deliberate*
// behavior change; a regression shows up as a failing characterization test, not a
// silent golden update.
//
// Usage (from repo root):  node tests/unit/fixtures/generate-golden.js
const fs = require('fs');
const path = require('path');
const { getUnifiedDomains, getCustomDomains } = require('../../../src/services/domain/index.js');
const { getCustomConfigs } = require('../../../src/services/application/custom.js');
const { getApplicationsToProcess } = require('../../../src/services/application/subset.js');

const specs = JSON.parse(fs.readFileSync(path.join(__dirname, 'characterization-specs.json'), 'utf8'));
const call = (fn) => { try { return fn(); } catch (e) { return { __throws: e.message }; } };

const golden = {};
for (const s of specs) {
  golden[s.name] = {
    version: s.version,
    unifiedDomains: call(() => getUnifiedDomains(s)),
    customDomains: call(() => getCustomDomains(s)),
    customConfigs: call(() => getCustomConfigs(s)),
  };
}
golden.__getApplicationsToProcess = call(() => getApplicationsToProcess(specs).map((a) => a.name));

fs.writeFileSync(path.join(__dirname, 'characterization-golden.json'), `${JSON.stringify(golden, null, 2)}\n`);
console.log(`golden written for ${specs.length} specs`);

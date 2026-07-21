// Exhaustive characterization sweep over the FULL real corpus (gitignored). Runs
// FDM's pure spec-shape functions over every real spec and writes their outputs.
// The committed 30-spec golden (tests/unit) is the CI floor; THIS is the net to run
// during the config-generation rewrite:
//
//   node tests/local/sweep.js            # baseline -> sweep-output.json (copy aside)
//   ...make a rewrite change...
//   node tests/local/sweep.js            # re-run, then diff:
//   git diff --no-index old-sweep.json tests/local/sweep-output.json
//
// Any change to a real spec's routing output surfaces here. `npm test` (the golden)
// must stay green independently.
//
// Requires tests/local/corpus-raw.json — pull it with:
//   curl -s https://api.runonflux.io/apps/globalappsspecifications > tests/local/corpus-raw.json
const fs = require('fs');
const path = require('path');
const { getUnifiedDomains, getCustomDomains } = require('../../src/services/domain/index.js');
const { getCustomConfigs } = require('../../src/services/application/custom.js');
const { getApplicationsToProcess } = require('../../src/services/application/subset.js');

const corpusPath = path.join(__dirname, 'corpus-raw.json');
if (!fs.existsSync(corpusPath)) {
  console.error('missing tests/local/corpus-raw.json — pull /apps/globalappsspecifications first (see README)');
  process.exit(1);
}
const corpus = JSON.parse(fs.readFileSync(corpusPath, 'utf8')).data;
const call = (fn) => { try { return fn(); } catch (e) { return { __throws: e.message }; } };

const out = {};
const throwsByFn = { unifiedDomains: 0, customDomains: 0, customConfigs: 0 };
for (const s of corpus) {
  out[s.name] = {
    version: s.version,
    unifiedDomains: call(() => getUnifiedDomains(s)),
    customDomains: call(() => getCustomDomains(s)),
    customConfigs: call(() => getCustomConfigs(s)),
  };
  for (const k of Object.keys(throwsByFn)) if (out[s.name][k] && out[s.name][k].__throws) throwsByFn[k] += 1;
}
out.__getApplicationsToProcess = call(() => getApplicationsToProcess(corpus).map((a) => a.name));

const outPath = path.join(__dirname, 'sweep-output.json');
fs.writeFileSync(outPath, `${JSON.stringify(out, null, 2)}\n`);
console.log(`swept ${corpus.length} specs — throws ${JSON.stringify(throwsByFn)} — wrote ${outPath}`);

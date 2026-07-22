// Regenerate the characterization golden from the CURRENT FDM code + committed
// fixtures. The golden is the exact output the config-generation rewrite must
// reproduce for every representative spec. Run intentionally after a *deliberate*
// behavior change; a regression shows up as a failing characterization test, not a
// silent golden update.
//
// Usage (from repo root):  node tests/unit/fixtures/generate-golden.js
const fs = require('fs').promises;
const path = require('path');
const { getUnifiedDomains, getCustomDomains } = require('../../../src/services/domain/index.js');
const { getCustomConfigs } = require('../../../src/services/application/custom.js');
const { getApplicationsToProcess } = require('../../../src/services/application/subset.js');
const { routeConfigsForSpec, renderConfig } = require('./renderPipeline');

const call = (fn) => { try { return fn(); } catch (e) { return { __throws: e.message }; } };
const callAsync = async (fn) => { try { return await fn(); } catch (e) { return { __throws: e.message }; } };

async function main() {
  const specs = JSON.parse(await fs.readFile(path.join(__dirname, 'characterization-specs.json'), 'utf8'));

  const golden = {};
  for (const s of specs) {
    golden[s.name] = {
      version: s.version,
      unifiedDomains: call(() => getUnifiedDomains(s)),
      customDomains: call(() => getCustomDomains(s)),
      customConfigs: call(() => getCustomConfigs(s)),
      // eslint-disable-next-line no-await-in-loop
      configuredApps: await callAsync(() => routeConfigsForSpec(s)),
    };
  }
  golden.__getApplicationsToProcess = call(() => getApplicationsToProcess(specs).map((a) => a.name));

  await fs.writeFile(path.join(__dirname, 'characterization-golden.json'), `${JSON.stringify(golden, null, 2)}\n`);

  // The full assembled haproxy config for the whole fixture set — the exact text
  // the renderer rewrite must still produce.
  await fs.writeFile(path.join(__dirname, 'characterization-haproxy.txt'), await renderConfig(specs));
  process.stdout.write(`golden written for ${specs.length} specs\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack}\n`);
  process.exitCode = 1;
});

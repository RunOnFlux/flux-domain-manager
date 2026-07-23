/* eslint-disable no-restricted-syntax */ // sequential await per spec over the corpus
// Regenerate the characterization golden from the CURRENT FDM code + committed
// fixtures. The golden is the exact output the config-generation rewrite must
// reproduce for every representative spec. Run intentionally after a *deliberate*
// behavior change; a regression shows up as a failing characterization test, not a
// silent golden update.
//
// Usage (from repo root):  node tests/unit/fixtures/generate-golden.js
const fs = require('fs').promises;
const path = require('path');
const { getCustomConfigs } = require('../../../src/services/application/custom');
const { getApplicationsToProcess } = require('../../../src/services/application/subset');
const { routeConfigsForSpec, domainsForSpec, renderConfig } = require('./renderPipeline');

// A call that threw is recorded as `{ threw }` in the slot its result would occupy, so a
// spec that cannot be projected is characterized rather than silently missing.
const call = (fn) => { try { return fn(); } catch (e) { return { threw: e.message }; } };
const callAsync = async (fn) => { try { return await fn(); } catch (e) { return { threw: e.message }; } };

async function main() {
  const specs = JSON.parse(await fs.readFile(path.join(__dirname, 'characterization-specs.json'), 'utf8'));

  // Per-spec projections and whole-corpus facts live in separate namespaces. They used to
  // share one flat object keyed by app name, with the corpus-level entry disambiguated
  // only by a `__` prefix — a naming convention doing a structure's job.
  const golden = { apps: {}, applicationsToProcess: [] };
  for (const s of specs) {
    // eslint-disable-next-line no-await-in-loop
    const d = await domainsForSpec(s);
    golden.apps[s.name] = {
      version: s.version,
      unifiedDomains: d.unifiedDomains,
      customDomains: d.customDomains,
      customConfigs: call(() => getCustomConfigs(s)),
      // eslint-disable-next-line no-await-in-loop
      configuredApps: await callAsync(() => routeConfigsForSpec(s)),
    };
  }
  golden.applicationsToProcess = call(() => getApplicationsToProcess(specs).map((a) => a.name));

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

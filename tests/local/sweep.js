// Exhaustive characterization sweep over the FULL real corpus (gitignored). Runs
// FDM's pure spec-shape functions AND the backend-config/renderer over every real
// spec and writes their outputs. The committed 30-spec golden (tests/unit) is the
// CI floor; THIS is the net to run during the config-generation rewrite:
//
//   node tests/local/sweep.js            # baseline -> sweep-output.json + sweep-haproxy.cfg (copy aside)
//   ...make a rewrite change...
//   node tests/local/sweep.js            # re-run, then diff:
//   git diff --no-index old-sweep.json tests/local/sweep-output.json
//
// Any change to a real spec's routing output surfaces here. `npm test` (the golden)
// must stay green independently.
//
// Requires tests/local/corpus-raw.json — pull it with:
//   curl -s https://api.runonflux.io/apps/globalappsspecifications > tests/local/corpus-raw.json
const fs = require('fs').promises;
const path = require('path');
const { getUnifiedDomains, getCustomDomains } = require('../../src/services/domain/index.js');
const { getCustomConfigs } = require('../../src/services/application/custom.js');
const { getApplicationsToProcess } = require('../../src/services/application/subset.js');
const { routeConfigsForSpec, renderConfig } = require('../unit/fixtures/renderPipeline');

const call = (fn) => { try { return fn(); } catch (e) { return { __throws: e.message }; } };
const callAsync = async (fn) => { try { return await fn(); } catch (e) { return { __throws: e.message }; } };

async function readCorpus(corpusPath) {
  try {
    return JSON.parse(await fs.readFile(corpusPath, 'utf8')).data;
  } catch {
    throw new Error('missing/unreadable tests/local/corpus-raw.json — pull /apps/globalappsspecifications first (see README)');
  }
}

async function main() {
  const corpus = await readCorpus(path.join(__dirname, 'corpus-raw.json'));

  const out = {};
  const throwsByFn = {
    unifiedDomains: 0, customDomains: 0, customConfigs: 0, configuredApps: 0,
  };
  for (const s of corpus) {
    out[s.name] = {
      version: s.version,
      unifiedDomains: call(() => getUnifiedDomains(s)),
      customDomains: call(() => getCustomDomains(s)),
      customConfigs: call(() => getCustomConfigs(s)),
      // eslint-disable-next-line no-await-in-loop
      configuredApps: await callAsync(() => routeConfigsForSpec(s)),
    };
    for (const k of Object.keys(throwsByFn)) if (out[s.name][k] && out[s.name][k].__throws) throwsByFn[k] += 1;
  }
  out.__getApplicationsToProcess = call(() => getApplicationsToProcess(corpus).map((a) => a.name));

  const outPath = path.join(__dirname, 'sweep-output.json');
  await fs.writeFile(outPath, `${JSON.stringify(out, null, 2)}\n`);

  // The full assembled config over every real spec — diff this file before/after a
  // renderer change to catch any byte that moved for the live app population.
  const cfgPath = path.join(__dirname, 'sweep-haproxy.cfg');
  await fs.writeFile(cfgPath, await renderConfig(corpus));
  process.stdout.write(`swept ${corpus.length} specs — throws ${JSON.stringify(throwsByFn)} — wrote ${outPath} + ${cfgPath}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack}\n`);
  process.exitCode = 1;
});

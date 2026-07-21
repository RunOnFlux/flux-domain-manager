// Regenerate the committed 30-spec anonymized characterization fixture from the
// full corpus. Greedy branch-coverage selection (every version + g:/r:/s: markers,
// custom domains, multi-component, enterprise, customConfigs rule hits), then
// anonymize owner ZelIDs + custom domains (and app/component names, EXCEPT for
// specs whose name drives a customConfigs rule — those names are already hardcoded
// in FDM's own custom.js). Preserves the shape features that drive each branch.
//
// Usage (from repo root):  node tests/local/curate.js
// Then regenerate the golden: node tests/unit/fixtures/generate-golden.js
const fs = require('fs');
const path = require('path');
const { getCustomConfigs } = require('../../src/services/application/custom.js');

const corpusPath = path.join(__dirname, 'corpus-raw.json');
if (!fs.existsSync(corpusPath)) {
  console.error('missing tests/local/corpus-raw.json — pull /apps/globalappsspecifications first (see README)');
  process.exit(1);
}
const corpus = JSON.parse(fs.readFileSync(corpusPath, 'utf8')).data;

const composeCD = (s) => (s.compose ? s.compose.map((c) => c.containerData || '').join('|') : (s.containerData || ''));

// A spec "hits a rule" iff the app/component NAME drives a different getCustomConfigs
// output — i.e. renaming it changes the result.
function hitsCustomConfigRule(s) {
  try {
    const real = JSON.stringify(getCustomConfigs(s));
    const scrubbed = JSON.parse(JSON.stringify(s));
    scrubbed.name = 'zzznomatchxyz';
    if (Array.isArray(scrubbed.compose)) scrubbed.compose.forEach((c) => { c.name = 'zzznomatchxyz'; });
    return real !== JSON.stringify(getCustomConfigs(scrubbed));
  } catch { return false; }
}

function features(s) {
  const f = new Set();
  f.add(`v${s.version}`);
  f.add(s.version <= 3 ? 'topLevelPorts' : 'compose');
  if (s.compose && s.compose.length > 1) f.add('multiComponent');
  const cd = composeCD(s);
  if (cd.includes('g:')) f.add('gMarker');
  if (cd.includes('r:')) f.add('rMarker');
  if (cd.includes('s:')) f.add('sMarker');
  if (s.enterprise) f.add('enterprise');
  const doms = s.version <= 3 ? (s.domains || []) : (s.compose || []).flatMap((c) => c.domains || []);
  const domStr = doms.filter(Boolean).join(',');
  if (domStr.replace(/,/g, '').length) f.add('customDomain');
  if (/www\./i.test(domStr)) f.add('customDomainWww');
  if (doms.some((d) => typeof d === 'string' && d.includes(','))) f.add('customDomainMulti');
  if (/app2\.runonflux\.io/i.test(domStr)) f.add('customDomainApp2');
  if (hitsCustomConfigRule(s)) f.add('customConfigRule');
  return f;
}

const TARGET = 30;
const scored = corpus.map((s) => ({ s, f: features(s), sig: [...features(s)].sort().join('+') }));
const allFeatures = new Set(scored.flatMap((x) => [...x.f]));
const covered = new Set();
const picked = [];
const pickedSigs = new Set();
while (covered.size < allFeatures.size && picked.length < TARGET) {
  let best = null; let bestGain = 0;
  for (const x of scored) {
    if (picked.includes(x)) continue;
    const gain = [...x.f].filter((k) => !covered.has(k)).length;
    if (gain > bestGain) { bestGain = gain; best = x; }
  }
  if (!best) break;
  picked.push(best); pickedSigs.add(best.sig);
  best.f.forEach((k) => covered.add(k));
}
for (const x of scored) {
  if (picked.length >= TARGET) break;
  if (picked.includes(x) || pickedSigs.has(x.sig)) continue;
  picked.push(x); pickedSigs.add(x.sig);
}

function anonDomainToken(d, ctr) {
  let prefix = ''; let rest = d;
  const proto = rest.match(/^(https?:\/\/)/i);
  if (proto) { prefix += proto[1]; rest = rest.slice(proto[1].length); }
  if (/^www\./i.test(rest)) { prefix += rest.slice(0, 4); rest = rest.slice(4); }
  if (/\.app2\.runonflux\.io$/i.test(rest)) return `${prefix}anon${ctr}.app2.runonflux.io`;
  const parts = rest.split('.');
  const tld = parts.length > 1 ? parts[parts.length - 1].replace(/[^a-z]/gi, '') || 'com' : 'com';
  return `${prefix}anon${ctr}.${tld}`;
}
let domCtr = 0;
function anonDomainField(val) {
  if (typeof val !== 'string') return val;
  return val.split(',').map((tok) => (tok.trim() ? anonDomainToken(tok.trim(), domCtr++) : tok)).join(',');
}
function anonymize(spec, i, feats) {
  const s = JSON.parse(JSON.stringify(spec));
  s.owner = `1AnonOwner${String(i).padStart(4, '0')}FixtureXXXXXXXXXXXX`.slice(0, 34);
  if (s.hash) s.hash = `anonhash${String(i).padStart(4, '0')}`;
  if (!feats.has('customConfigRule')) {
    s.name = `anonapp${i}`;
    if (Array.isArray(s.compose)) s.compose.forEach((c, j) => { c.name = `anoncomp${i}_${j}`; });
  }
  if (Array.isArray(s.domains)) s.domains = s.domains.map(anonDomainField);
  if (Array.isArray(s.compose)) s.compose.forEach((c) => { if (Array.isArray(c.domains)) c.domains = c.domains.map(anonDomainField); });
  if (typeof s.enterprise === 'string' && s.enterprise.length > 24) s.enterprise = `${s.enterprise.slice(0, 12)}...anon`;
  return s;
}

const fixtures = picked.map((x, i) => anonymize(x.s, i, x.f));
const outPath = path.join(__dirname, '..', 'unit', 'fixtures', 'characterization-specs.json');
fs.writeFileSync(outPath, `${JSON.stringify(fixtures, null, 2)}\n`);

const missing = [...allFeatures].filter((k) => !covered.has(k));
console.log(`picked ${fixtures.length}/${corpus.length} specs; branch coverage: ${missing.length ? `MISSING ${missing.join(', ')}` : 'complete'}`);
console.log(`wrote ${outPath} — now run: node tests/unit/fixtures/generate-golden.js`);

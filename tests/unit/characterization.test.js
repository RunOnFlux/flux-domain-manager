/* eslint-disable func-names */
// Golden characterization of FDM's pure spec-shape functions across a
// representative, anonymized slice of real production specs (every version +
// every branch: g:/r:/s: markers, custom domains, multi-component, enterprise,
// customConfigs rule hits). This LOCKS current behavior so the v9 config-
// generation rewrite is provably non-regressing: as the code is restructured
// (flux-spec DeploymentSpec, the renderer, config extraction), these outputs must
// not change. A deliberate behavior change is applied by regenerating the golden
// (tests/unit/fixtures/generate-golden.js), never by editing it by hand.
//
// The committed fixture is a 30-spec subset for CI; the exhaustive 731-spec sweep
// lives in tests/local/ (corpus is gitignored) — run it during the rewrite.
const chai = require('chai');
const fs = require('fs');
const path = require('path');
const { getUnifiedDomains, getCustomDomains } = require('../../src/services/domain/index.js');
const { getCustomConfigs } = require('../../src/services/application/custom.js');
const { getApplicationsToProcess } = require('../../src/services/application/subset.js');
const { routeConfigsForSpec, renderConfig } = require('./fixtures/renderPipeline');

const { expect } = chai;

const FIX = path.join(__dirname, 'fixtures');
const specs = JSON.parse(fs.readFileSync(path.join(FIX, 'characterization-specs.json'), 'utf8'));
const golden = JSON.parse(fs.readFileSync(path.join(FIX, 'characterization-golden.json'), 'utf8'));
const renderedGolden = fs.readFileSync(path.join(FIX, 'characterization-haproxy.txt'), 'utf8');
const call = (fn) => { try { return fn(); } catch (e) { return { __throws: e.message }; } };
const callAsync = async (fn) => { try { return await fn(); } catch (e) { return { __throws: e.message }; } };

describe('characterization — pure spec-shape functions vs golden (real anonymized specs)', function () {
  specs.forEach((s) => {
    describe(`${s.name} (v${s.version})`, function () {
      const g = golden[s.name];
      it('has a golden entry', function () { expect(g, `no golden for ${s.name}`).to.be.an('object'); });
      it('getUnifiedDomains matches golden', function () {
        expect(call(() => getUnifiedDomains(s))).to.deep.equal(g.unifiedDomains);
      });
      it('getCustomDomains matches golden', function () {
        expect(call(() => getCustomDomains(s))).to.deep.equal(g.customDomains);
      });
      it('getCustomConfigs matches golden', function () {
        expect(call(() => getCustomConfigs(s))).to.deep.equal(g.customConfigs);
      });
      it('route configs match golden', async function () {
        expect(await callAsync(() => routeConfigsForSpec(s))).to.deep.equal(g.configuredApps);
      });
    });
  });

  it('getApplicationsToProcess matches golden', function () {
    expect(call(() => getApplicationsToProcess(specs).map((a) => a.name)))
      .to.deep.equal(golden.__getApplicationsToProcess);
  });

  it('the full assembled haproxy config matches golden byte-for-byte', async function () {
    expect(await renderConfig(specs)).to.equal(renderedGolden);
  });
});

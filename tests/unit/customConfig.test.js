'use strict';

// A per-route tuning rule is keyed {hostPort}.{component}.{app}. Rules were written for
// legacy names, some with capitals; a v9 name is lowercase only, so the lookup ignores
// case.
const { expect } = require('chai');
const config = require('config');
const { resolveCustomConfig, getCustomConfigs, buildDefaultConfig } = require('../../src/services/application/custom');

const RULE_KEY = '31350.KadefiPactAPI.KadefiMoneyPactAPI';
const rule = config.customConfigs[RULE_KEY];

describe('per-route tuning rules', () => {
  it('apply to a route whose names are lowercase', () => {
    const resolved = resolveCustomConfig('kadefimoneypactapi', 'kadefipactapi', 31350, false);
    expect(resolved).to.deep.equal({ ...buildDefaultConfig('kadefimoneypactapi', false), ...rule });
  });

  it('apply to a route named exactly as the rule', () => {
    const resolved = resolveCustomConfig('KadefiMoneyPactAPI', 'KadefiPactAPI', 31350, false);
    expect(resolved).to.deep.equal({ ...buildDefaultConfig('KadefiMoneyPactAPI', false), ...rule });
  });

  it('leave a route no rule names on the default', () => {
    expect(resolveCustomConfig('someapp', 'web', 31350, false)).to.deep.equal(buildDefaultConfig('someapp', false));
  });

  it('apply through the positional projection too, whatever the case', () => {
    const spec = {
      version: 7,
      name: 'kadefimoneypactapi',
      compose: [{ name: 'kadefipactapi', ports: [31350] }],
    };
    expect(getCustomConfigs(spec, false)[0]).to.deep.equal({ ...buildDefaultConfig('kadefimoneypactapi', false), ...rule });
  });

  it('never name the same route twice once case is ignored', () => {
    const keys = Object.keys(config.customConfigs).map((key) => key.toLowerCase());
    expect(new Set(keys).size).to.equal(keys.length);
  });
});

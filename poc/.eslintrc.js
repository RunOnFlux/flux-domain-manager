// The benchmark harness, not shipped code. Two airbnb rules do not fit a
// measurement rig and are turned off here rather than sprinkled through the
// files: a seeded PRNG is bitwise by construction (the scenario has to be
// reproducible run to run, or a before/after comparison means nothing), and the
// fleet server iterates ports and placements where the array-method form would
// only obscure what it does.
module.exports = {
  rules: {
    'no-bitwise': 'off',
    'no-restricted-syntax': 'off',
    'operator-assignment': 'off',
  },
};

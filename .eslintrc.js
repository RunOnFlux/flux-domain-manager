'use strict';

module.exports = {
  root: true,
  env: {
    commonjs: true,
    node: true,
    mocha: true,
  },
  extends: ['airbnb-base'],
  rules: {
    'max-len': [
      'error',
      {
        // this should be 120 absolute max
        code: 300,
        ignoreUrls: true,
        ignoreTrailingComments: true,
      },
    ],
    'no-console': 'off',
    'default-param-last': 'off',
    'import/extensions': ['error', 'never'],
    'linebreak-style': ['error', 'unix'],
    // airbnb-base forbids the directive, on the assumption that everything is an
    // ES module and therefore strict already. Nothing here is: this package is
    // CommonJS, Node loads it sloppy, and sloppy is where a write to a frozen
    // object does nothing instead of throwing. 'safe' asks for exactly what the
    // source type needs — one directive per file while these are scripts, none
    // if a subtree ever becomes ESM.
    strict: ['error', 'safe'],
  },
  parserOptions: {
    parser: 'babel-eslint',
    ecmaVersion: 'latest',
    // FDM is CommonJS — require() and module.exports end to end, and package.json
    // declares no "type": "module". Left unset, eslint assumed 'module' and so
    // believed every file was already strict, which is the opposite of what Node
    // does: it loads them sloppy, where assigning to a frozen object's property
    // does nothing instead of throwing. The linter was asserting the absence of
    // the very hazard the 'use strict' directives exist to surface.
    sourceType: 'script',
  },
  overrides: [
    {
      files: ['**/__tests__/*.{j,t}s?(x)'],
      env: {
        mocha: true,
      },
    },
    {
      // The line/section/config classes are one cohesive AST and belong in one
      // module. This lives here rather than as an inline disable because the rule
      // reports at 1:1: an inline comment covers the whole file only while nothing
      // precedes it, and the file's 'use strict' directive is code.
      files: ['src/services/haproxy/configModel.js'],
      rules: { 'max-classes-per-file': 'off' },
    },
  ],
};

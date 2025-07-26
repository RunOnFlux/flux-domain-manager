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
  },
  parserOptions: {
    parser: 'babel-eslint',
    ecmaVersion: 'latest',
  },
  overrides: [
    {
      files: ['**/__tests__/*.{j,t}s?(x)'],
      env: {
        mocha: true,
      },
    },
  ],
};

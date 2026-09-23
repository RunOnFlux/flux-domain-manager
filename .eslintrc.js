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
    {
      // Outbound connections are created only by src/lib/outbound.js, which gives
      // every socket the options that stop it blocking a haproxy listener bind.
      files: ['src/**/*.js'],
      excludedFiles: ['src/lib/outbound.js'],
      rules: {
        'no-restricted-modules': ['error', {
          paths: ['axios', 'http', 'https', 'net', 'tls', 'node:http', 'node:https', 'node:net', 'node:tls']
            .map((name) => ({ name, message: 'Create outbound connections with src/lib/outbound.js.' })),
        }],
        'no-restricted-globals': ['error', {
          name: 'fetch',
          message: 'Create outbound connections with src/lib/outbound.js.',
        }],
      },
    },
  ],
};

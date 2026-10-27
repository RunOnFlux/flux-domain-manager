const chai = require('chai');
const { getCustomDomains } = require('../src/services/domain/index');

const { expect } = chai;

describe('getCustomDomains', () => {
  it('trims whitespace around comma-separated domains of a compose app', () => {
    const app = {
      version: 8,
      compose: [{ ports: [5000], domains: ['www.example.com, api.example.com'] }],
    };
    expect(getCustomDomains(app)).to.deep.equal([
      'example.com', 'www.example.com', 'test.example.com',
      'api.example.com', 'www.api.example.com', 'test.api.example.com',
    ]);
  });

  it('trims whitespace around comma-separated domains of a v3 app', () => {
    const app = {
      version: 3,
      ports: [5000],
      domains: [' example.com ,api.example.com '],
    };
    expect(getCustomDomains(app)).to.deep.equal([
      'example.com', 'www.example.com', 'test.example.com',
      'api.example.com', 'www.api.example.com', 'test.api.example.com',
    ]);
  });
});

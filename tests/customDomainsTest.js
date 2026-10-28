const chai = require('chai');
const config = require('config');
const log = require('../src/lib/log');
const { getCustomDomains } = require('../src/services/domain/index');
const { isHostname, parseCustomDomain, parseCustomDomains } = require('../src/services/domain/customDomain');

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

describe('parseCustomDomain', () => {
  it('accepts a hostname and normalises its spelling', () => {
    [
      ['example.com', 'example.com'],
      ['Example.COM', 'example.com'],
      ['  example.com  ', 'example.com'],
      ['https://example.com', 'example.com'],
      ['http://example.com/', 'example.com'],
      ['https://example.com/some/path?q=1', 'example.com'],
      ['example.com.', 'example.com'],
      ['www.example.com', 'example.com'],
      ['awww.example.com', 'awww.example.com'],
      ['a-b.c-d.example.co.uk', 'a-b.c-d.example.co.uk'],
      ['xn--bcher-kva.example', 'xn--bcher-kva.example'],
      ['shop.xn--p1ai', 'shop.xn--p1ai'],
      ['1.2.3.example', '1.2.3.example'],
      [`${'a'.repeat(63)}.com`, `${'a'.repeat(63)}.com`],
    ].forEach(([entry, expected]) => {
      expect(parseCustomDomain(entry), JSON.stringify(entry)).to.equal(expected);
    });
  });

  it('rejects every entry that is not a plain hostname', () => {
    [
      'example.com\n  use_backend x if TRUE',
      'example.com\r\nacl x always_true',
      'example.com\u0000',
      'exa\tmple.com',
      'exa mple.com',
      'example.com #comment',
      'example.com{x}',
      '`id`.example.com',
      'a;id.example.com',
      'a|sh.example.com',
      '$(id).example.com',
      '--pre-hook=x.example.com',
      '-a.example.com',
      'a-.example.com',
      'a..example.com',
      '.example.com',
      'example',
      'localhost',
      '1.2.3.4',
      '1.2.3.44',
      'example.com:8080',
      'user@example.com',
      'café.example.com',
      'exa_mple.com',
      '*.example.com',
      `${'a'.repeat(64)}.com`,
      `${'a.'.repeat(126)}com`,
      'www.',
      'https://',
      '',
    ].forEach((entry) => {
      expect(parseCustomDomain(entry), JSON.stringify(entry)).to.equal(null);
    });
  });

  it('rejects names inside the Flux app zone', () => {
    const zone = `${config.appSubDomain}.${config.mainDomain}`;
    expect(parseCustomDomain(zone)).to.equal(null);
    expect(parseCustomDomain(`otherapp.${zone}`)).to.equal(null);
    expect(parseCustomDomain(`otherapp_80.${zone}`)).to.equal(null);
    expect(parseCustomDomain(`otherapp.${zone}.example.com`)).to.equal(`otherapp.${zone}.example.com`);
  });

  it('accepts a name of 253 characters and rejects 254', () => {
    const name253 = `${'a'.repeat(61)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(63)}`;
    expect(name253).to.have.lengthOf(253);
    expect(isHostname(name253)).to.equal(true);
    expect(isHostname(`a${name253}`)).to.equal(false);
  });

  it('takes linear time on a megabyte of input', () => {
    ['a'.repeat(1e6), `${'a-'.repeat(5e5)}!`, `${'a.'.repeat(5e5)}!`, `https://${'/'.repeat(1e6)}`].forEach((entry) => {
      const start = process.hrtime.bigint();
      expect(parseCustomDomain(entry)).to.equal(null);
      expect(Number(process.hrtime.bigint() - start) / 1e6).to.be.below(100);
    });
  });
});

describe('parseCustomDomains', () => {
  it('keeps the valid entries of a list and drops the rest', () => {
    expect(parseCustomDomains('good.com, bad\n.com ,www.good.com,,other.org', 'app')).to.deep.equal(['good.com', 'other.org']);
  });

  it('logs a rejected entry only when it contains a dot', () => {
    const { warn } = log;
    const warnings = [];
    log.warn = (message) => warnings.push(message);
    try {
      expect(parseCustomDomains('"",[""],null,localhost,,bad\n.com', 'quietapp')).to.deep.equal([]);
    } finally {
      log.warn = warn;
    }
    expect(warnings).to.have.lengthOf(1);
    expect(warnings[0]).to.include('bad\\n.com').and.include('quietapp');
  });

  it('gives nothing for a value that is not a string', () => {
    [undefined, null, 5, ['a.com'], { a: 'b.com' }].forEach((value) => {
      expect(parseCustomDomains(value, 'app')).to.deep.equal([]);
    });
  });
});

describe('getCustomDomains with hostile entries', () => {
  it('certifies only valid hostnames, so a domain never reaches certbot unchecked', () => {
    const app = {
      name: 'hostile',
      version: 8,
      compose: [
        { ports: [5000, 5001], domains: ['ok.example.com,`id`.example.com', 'x.com\nbad'] },
        { ports: [6000], domains: ['--pre-hook=x.example.com,second.example.com'] },
      ],
    };
    expect(getCustomDomains(app)).to.deep.equal([
      'ok.example.com', 'www.ok.example.com', 'test.ok.example.com',
      'second.example.com', 'www.second.example.com', 'test.second.example.com',
    ]);
  });
});

// The generic HAProxy config model: directives are keyword + tokens (any directive
// representable, empty tokens dropped), sections keep insertion order, and the whole
// renders with clean deterministic whitespace.
const chai = require('chai');
const {
  HaproxyConfig, Section, Directive, Comment, Blank, parse,
} = require('../../src/services/haproxy/configModel');

const { expect } = chai;

describe('configModel', () => {
  describe('Directive', () => {
    it('renders keyword + args joined by single spaces, indented', () => {
      expect(new Directive('balance', ['roundrobin']).render('  ')).to.equal('  balance roundrobin');
    });

    it('drops empty/null/undefined args so absent optional clauses leave no whitespace', () => {
      const server = new Directive('server', ['s1', '1.2.3.4:80', 'check', '', null, undefined, 'backup']);
      expect(server.render('  ')).to.equal('  server s1 1.2.3.4:80 check backup');
    });

    it('keeps multi-token arg strings intact', () => {
      expect(new Directive('option', ['httpchk GET /health']).render('  '))
        .to.equal('  option httpchk GET /health');
    });

    it('renders a bare keyword with no args', () => {
      expect(new Directive('redispatch', []).render('  ')).to.equal('  redispatch');
    });
  });

  describe('Section', () => {
    it('renders a named header at column 0 with a two-space indented body', () => {
      const s = new Section('backend', 'appbackend');
      s.add('mode', 'http').add('balance', 'roundrobin');
      expect(s.render()).to.equal('backend appbackend\n  mode http\n  balance roundrobin');
    });

    it('renders a bare (unnamed) section header', () => {
      const s = new Section('global');
      s.add('maxconn', '4096');
      expect(s.render()).to.equal('global\n  maxconn 4096');
    });

    it('preserves insertion order (interleaved acl / use_backend)', () => {
      const s = new Section('frontend', 'www');
      s.add('acl', 'a', 'hdr(host)', 'a.com');
      s.add('use_backend', 'abackend', 'if', 'a');
      s.add('acl', 'b', 'hdr(host)', 'b.com');
      s.add('use_backend', 'bbackend', 'if', 'b');
      expect(s.render().split('\n').slice(1)).to.deep.equal([
        '  acl a hdr(host) a.com',
        '  use_backend abackend if a',
        '  acl b hdr(host) b.com',
        '  use_backend bbackend if b',
      ]);
    });

    it('supports comments and blank lines, and pushing pre-built directives', () => {
      const s = new Section('defaults');
      s.comment('timeouts').add('timeout', 'connect', '5s').blank().push(new Directive('retries', ['3']));
      expect(s.render()).to.equal('defaults\n  # timeouts\n  timeout connect 5s\n\n  retries 3');
    });
  });

  describe('HaproxyConfig', () => {
    it('joins sections with one blank line and ends with a trailing newline', () => {
      const cfg = new HaproxyConfig();
      cfg.section('global').add('maxconn', '4096');
      cfg.section('defaults').add('mode', 'http');
      expect(cfg.render()).to.equal('global\n  maxconn 4096\n\ndefaults\n  mode http\n');
    });
  });

  it('exposes Comment and Blank as line primitives', () => {
    expect(new Comment('x').render('  ')).to.equal('  # x');
    expect(new Blank().render('  ')).to.equal('');
  });

  describe('parse', () => {
    it('splits section headers (with/without name) and body lines, dropping blanks', () => {
      const cfg = parse('\nglobal\n  maxconn 4096\n\nfrontend www\n  bind *:80\n  use_backend b if a\n');
      expect(cfg.sections.map((s) => [s.type, s.name])).to.deep.equal([['global', null], ['frontend', 'www']]);
      expect(cfg.render()).to.equal('global\n  maxconn 4096\n\nfrontend www\n  bind *:80\n  use_backend b if a\n');
    });

    it('appending to a parsed section keeps insertion order (fold static + dynamic)', () => {
      const cfg = parse('frontend www\n  bind *:80\n');
      cfg.sections[0].add('acl', 'a', 'hdr(host)', 'x.com').add('use_backend', 'b', 'if', 'a');
      expect(cfg.render()).to.equal('frontend www\n  bind *:80\n  acl a hdr(host) x.com\n  use_backend b if a\n');
    });
  });
});

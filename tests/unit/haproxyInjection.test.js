// Owner-controlled spec values are written into a shared haproxy configuration file. That
// file carries every app on a director, and haproxy accepts whatever parses — so a value
// that closes its own directive and starts another is arbitrary config, and a value that
// merely fails to parse takes the whole file down with it.
//
// The property, for every owner-controlled field that reaches the config:
//
//   either the spec is REJECTED at validation,
//   or the rendered backend contains ONLY directives we chose to emit.
//
// Nothing in between. A payload that survives validation and adds a line is an injection;
// a payload that survives and produces something haproxy rejects is a fleet-wide outage,
// since restartProxy refuses the config and every app stops getting routing updates.
const chai = require('chai');
const { load } = require('@runonflux/flux-spec-cjs');
const specLibs = require('../../src/services/flux/specLibs');
const { buildRouteConfigs } = require('../../src/services/haproxy/buildRouteConfigs');
const { looseBackends, looseDeployments } = require('./fixtures/renderPipeline');
const { generateDomainBackend } = require('../../src/services/haproxyTemplate');

const { expect } = chai;

// Everything haproxy's own config tokeniser treats as syntax (src/tools.c parse_line):
// line breaks, whitespace, the comment marker, both quote forms, the escape character and
// the environment-variable sigil. Plus the escape sequences parse_line itself expands —
// `\n` and `\x0a` become real control characters inside an argument — and payloads shaped
// like the directives an attacker would actually want.
const HOSTILE = [
  ['newline', '\n  http-request deny'],
  ['carriage return', '\r  http-request deny'],
  ['CRLF', '\r\n  http-request deny'],
  ['tab', '\t  http-request deny'],
  ['form feed', '\f  http-request deny'],
  ['vertical tab', '\v  http-request deny'],
  ['NUL', '\u0000  http-request deny'],
  ['escape sequence \\n', '\\n  http-request deny'],
  ['hex escape \\x0a', '\\x0a  http-request deny'],
  ['space then directive', ' http-request deny'],
  ['comment marker', '# http-request deny'],
  ['double quote', '" http-request deny'],
  ['single quote', "' http-request deny"],
  ['backslash', '\\ http-request deny'],
  ['env sigil', '$PATH'],
  ['env braces', `${String.fromCharCode(36)}{PATH}`],
  ['new backend section', '\nbackend hijacked\n  server evil 10.6.6.6:1'],
  ['extra server line', '\n  server evil 10.6.6.6:1'],
  ['non-ascii', 'é中'],
  ['very long', 'a'.repeat(5000)],
  ['leading whitespace', '   value'],
  ['trailing whitespace', 'value   '],
  ['empty', ''],
];

// A benign value for each field, of the same shape as the hostile one. An owner-supplied
// value is always a single argument on a single line, so a hostile value that renders at
// all must produce exactly the same number of lines as a benign one. Anything more is a
// line the owner added — which is the whole attack, whatever keyword it uses.
//
// An earlier version of this test compared directive keywords against an allow-list. That
// is unsound: `http-request` is a directive FDM legitimately emits, so an injected
// `http-request deny` was indistinguishable from a real one and the test passed against a
// known-vulnerable schema. Counting lines does not care what the payload is called.

const submission = (overrides) => ({
  version: 9,
  name: 'shop',
  description: 'x',
  owner: '16dNCFf7nR3nx5iwn2RQMBw6KcJXkE3JC1',
  ttl: 2592000,
  instances: 1,
  contacts: { email: ['a@b.com'] },
  components: {
    web: {
      name: 'web',
      description: 'x',
      image: 'nginx:latest',
      cpu: 0.5,
      memory: 300,
      rootFsGb: 2,
      persistentStorage: { sizeGb: 10, mounts: { '/data': { source: 'data', destination: '/data' } } },
      ports: { http: { containerPort: 80, hostPort: 31000 } },
      loadBalancing: { http: { provider: 'haproxy', mode: 'http', ...overrides } },
    },
  },
});

// Render through the real pipeline. Returns null when the spec is refused anywhere on the
// way — refusal is a pass, and which layer refused is not this test's business.
async function renderOrReject(overrides) {
  const { FluxAppSpecV9 } = await load();
  let wire;
  try {
    wire = FluxAppSpecV9.fromSubmission(submission(overrides)).serialize();
  } catch (e) {
    return null;
  }
  try {
    const dep = await specLibs.resolveDeployment(await specLibs.deserialize(wire), null);
    const backends = looseBackends(['144.76.10.20:16127']);
    const routeConfigs = buildRouteConfigs(looseDeployments(dep), 'shop', backends, false, false);
    const platform = routeConfigs.find((c) => c.domain.startsWith('shop_'));
    if (!platform) return null;
    return generateDomainBackend(platform, 'http').render();
  } catch (e) {
    return null;
  }
}

// Control characters must never survive into the file at all: haproxy's own tokeniser
// expands \n and \xNN inside an argument, so a value carrying them is already wrong even
// when it does not split the line here.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;

function assertNoControlCharacters(block, label) {
  const offending = block.split('\n').filter((l) => CONTROL.test(l));
  expect(offending, `${label}: control characters in rendered config`).to.deep.equal([]);
}

describe('haproxy config injection — owner-controlled values', () => {
  // Each entry: the field, how to place a value into a submission, and a benign value of
  // the same shape to measure against.
  // The payload is embedded in an otherwise-VALID value for each field, and the reference
  // render is the same field with an empty payload. Prefixing matters:
  // a path of "\n..." fails even the old `^/` pattern, so testing it that way proves
  // nothing — every case would take the rejected branch for the wrong reason. The attack
  // is a valid-looking value that carries a second line.
  const FIELDS = [
    ['healthCheck.path', (v) => ({ healthCheck: { path: `/health${v}` } })],
    ['healthCheck.expectString', (v) => ({ healthCheck: { path: '/h', expectString: `ok${v}` } })],
    ['healthCheck.expectedStatus', (v) => ({ healthCheck: { path: '/h', expectedStatus: `200${v}` } })],
    ['healthCheck.method', (v) => ({ healthCheck: { path: '/h', method: `GET${v}` } })],
    ['healthCheck.interval', (v) => ({ healthCheck: { path: '/h', interval: `5s${v}` } })],
    ['stickySessions.cookieName', (v) => ({ stickySessions: { cookieName: `SRVID${v}` } })],
    ['balancing', (v) => ({ balancing: `roundrobin${v}` })],
    ['scheme', (v) => ({ scheme: `httpsRedirect${v}` })],
    ['backendTls.verify', (v) => ({ backendTls: { verify: `none${v}` } })],
    ['timeouts.server', (v) => ({ timeouts: { server: `30s${v}` } })],
    ['retries.retryOn', (v) => ({ retries: { count: 3, retryOn: [`conn-failure${v}`] } })],
    ['customDomains', (v) => ({ customDomains: [`shop.example.com${v}`] })],
  ];

  FIELDS.forEach(([field, build]) => {
    describe(field, () => {
      HOSTILE.forEach(([name, payload]) => {
        it(`is rejected, or adds no line, for ${name}`, async () => {
          const block = await renderOrReject(build(payload));
          if (block === null) return; // refused — the desired outcome

          const reference = await renderOrReject(build(''));
          expect(reference, `${field}: base value must render`).to.not.equal(null);

          const label = `${field} / ${name}`;
          assertNoControlCharacters(block, label);
          expect(
            block.split('\n').length,
            `${label}: payload changed the line count — injected config:\n${block}`,
          ).to.equal(reference.split('\n').length);
        });
      });
    });
  });

  // A half-formed check: every field the renderer reads must be materialized by
  // fillDefaults, or the config gets the string "undefined" and haproxy refuses the file.
  describe('half-formed configuration', () => {
    const PARTIALS = [
      ['healthCheck bare', { healthCheck: {} }],
      ['healthCheck path only', { healthCheck: { path: '/health' } }],
      ['stickySessions bare', { stickySessions: {} }],
      ['timeouts partial', { timeouts: { server: '30s' } }],
      ['retries partial', { retries: { count: 2 } }],
      ['backendTls bare', { backendTls: {} }],
      ['drain bare', { drain: {} }],
    ];

    PARTIALS.forEach(([label, overrides]) => {
      it(`renders no undefined or null for ${label}`, async () => {
        const block = await renderOrReject(overrides);
        if (block === null) return;
        expect(block, label).to.not.match(/\bundefined\b/);
        expect(block, label).to.not.match(/\bNaN\b/);
        expect(block, label).to.not.match(/\[object Object\]/);
        assertNoControlCharacters(block, label);
      });
    });
  });
});

// The provisioning pass runs before the render and guarantees the invariant the renderer
// relies on: a `verify: required` app's CA is on disk before its ca-file is named. It must
// fetch each app's CA once (not once per route), write idempotently, and — critically —
// isolate a single app's fetch failure so one unreachable CA never stops routing for the
// rest of the fleet. Here the fetcher is a stub and writes go to a temp dir.
const { expect } = require('chai');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { provisionBackendCas, requiredVerifyAppNames } = require('../../src/services/haproxy/provisionBackendCas');

const routeFor = (name, verify) => ({ name, backendTls: verify ? { verify } : null });
const PEM = (name) => `-----BEGIN CERTIFICATE-----\n${name}\n-----END CERTIFICATE-----\n`;

let dir;
beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'fdm-ca-'));
});
afterEach(async () => {
  await fsp.rm(dir, { recursive: true, force: true });
});

const caPath = (name) => path.join(dir, `flux-ca-${name}.pem`);

describe('requiredVerifyAppNames', () => {
  it('collects only verify:required apps, de-duplicated by name', () => {
    const names = requiredVerifyAppNames([
      routeFor('a', 'required'),
      routeFor('a', 'required'), // second route for the same app
      routeFor('b', 'none'),
      routeFor('c', null),
      routeFor('d', 'required'),
    ]);
    expect([...names].sort()).to.deep.equal(['a', 'd']);
  });
});

describe('provisionBackendCas', () => {
  it('fetches each required app once and writes its CA, returning the ready set', async () => {
    const calls = [];
    const fetcher = { fetchCaCertificate: async (name) => { calls.push(name); return PEM(name); } };

    const ready = await provisionBackendCas(
      [routeFor('shop', 'required'), routeFor('shop', 'required'), routeFor('blog', 'required')],
      fetcher,
      { dir },
    );

    expect([...ready].sort()).to.deep.equal(['blog', 'shop']);
    expect(calls.sort()).to.deep.equal(['blog', 'shop']); // shop fetched once despite two routes
    expect(fs.readFileSync(caPath('shop'), 'utf8')).to.equal(PEM('shop'));
    expect(fs.readFileSync(caPath('blog'), 'utf8')).to.equal(PEM('blog'));
  });

  it('does nothing and returns an empty set when no app asks for verification', async () => {
    let called = false;
    const fetcher = { fetchCaCertificate: async () => { called = true; return PEM('x'); } };

    const ready = await provisionBackendCas([routeFor('a', 'none'), routeFor('b', null)], fetcher, { dir });

    expect([...ready]).to.deep.equal([]);
    expect(called).to.equal(false);
  });

  it('isolates a single app failure: the others still provision and route', async () => {
    const fetcher = {
      fetchCaCertificate: async (name) => {
        if (name === 'broken') throw new Error('crypto service rejected CA request for broken');
        return PEM(name);
      },
    };

    const ready = await provisionBackendCas(
      [routeFor('ok1', 'required'), routeFor('broken', 'required'), routeFor('ok2', 'required')],
      fetcher,
      { dir },
    );

    expect([...ready].sort()).to.deep.equal(['ok1', 'ok2']);
    expect(fs.existsSync(caPath('broken'))).to.equal(false);
    expect(fs.existsSync(caPath('ok1'))).to.equal(true);
  });

  it('skips the fetch entirely when the CA is already on disk (immutable, ready without a call)', async () => {
    let calls = 0;
    const fetcher = { fetchCaCertificate: async (name) => { calls += 1; return PEM(name); } };

    await provisionBackendCas([routeFor('shop', 'required')], fetcher, { dir });
    expect(calls).to.equal(1); // first appearance fetches

    // A later cycle finds the file present: still ready, no fetch, contents untouched.
    const ready = await provisionBackendCas([routeFor('shop', 'required')], fetcher, { dir });

    expect(calls).to.equal(1); // not called again
    expect([...ready]).to.deep.equal(['shop']);
    expect(fs.readFileSync(caPath('shop'), 'utf8')).to.equal(PEM('shop'));
  });

  it('leaves no stray temp file behind after an atomic write', async () => {
    const fetcher = { fetchCaCertificate: async (name) => PEM(name) };
    await provisionBackendCas([routeFor('shop', 'required')], fetcher, { dir });
    expect(fs.existsSync(caPath('shop'))).to.equal(true);
    expect(fs.readdirSync(dir).some((f) => f.endsWith('.tmp'))).to.equal(false);
  });
});

// Nothing else deletes these files and "exists => trust" means they are never rewritten,
// so without a prune the directory grows by one file per app that ever used required-verify.
// The liveness mark is the file's mtime, on disk rather than in memory, so the countdown
// survives the director restarting — the case an in-memory timer gets wrong in both
// directions (forgets a pending removal, or restarts the clock on every boot).
describe('provisionBackendCas — pruning CAs of removed apps', () => {
  const fetcher = { fetchCaCertificate: async (name) => PEM(name) };
  const HOUR = 60 * 60 * 1000;
  const GRACE = 24 * HOUR;

  // Age a CA's liveness mark, standing in for cycles that ran without it.
  const ageBy = async (name, ms) => {
    const when = new Date(Date.now() - ms);
    await fsp.utimes(caPath(name), when, when);
  };

  it('removes a departed app\'s CA once it is past the grace period', async () => {
    await provisionBackendCas([routeFor('shop', 'required')], fetcher, { dir, graceMs: GRACE });
    expect(fs.existsSync(caPath('shop'))).to.equal(true);

    // The app is gone from the routing view, and has been for over a day.
    await ageBy('shop', GRACE + HOUR);
    await provisionBackendCas([], fetcher, { dir, graceMs: GRACE });

    expect(fs.existsSync(caPath('shop'))).to.equal(false);
  });

  it('keeps a departed app\'s CA while it is still inside the grace period', async () => {
    await provisionBackendCas([routeFor('shop', 'required')], fetcher, { dir, graceMs: GRACE });

    // A bad cycle - truncated app list, a blip in the routing view - costs nothing.
    await ageBy('shop', 23 * HOUR);
    await provisionBackendCas([], fetcher, { dir, graceMs: GRACE });

    expect(fs.existsSync(caPath('shop'))).to.equal(true);
  });

  it('refreshes the mark of a still-routed app, so a long-lived app never ages out', async () => {
    await provisionBackendCas([routeFor('shop', 'required')], fetcher, { dir, graceMs: GRACE });
    // Stands in for a director that was down far longer than the grace period: the marks
    // are refreshed before anything is deleted, so downtime is not mistaken for disuse.
    await ageBy('shop', 30 * 24 * HOUR);

    await provisionBackendCas([routeFor('shop', 'required')], fetcher, { dir, graceMs: GRACE });

    expect(fs.existsSync(caPath('shop'))).to.equal(true);
    expect(Date.now() - fs.statSync(caPath('shop')).mtimeMs).to.be.lessThan(5000);
  });

  it('keeps the CA of a routed app whose fetch is currently failing', async () => {
    await provisionBackendCas([routeFor('shop', 'required')], fetcher, { dir, graceMs: GRACE });
    await ageBy('shop', GRACE + HOUR);

    // Liveness is the routing view, not the fetch outcome — the app is still live and
    // being retried, so its CA must not age out underneath it.
    const broken = { fetchCaCertificate: async () => { throw new Error('crypto service down'); } };
    await provisionBackendCas([routeFor('shop', 'required')], broken, { dir, graceMs: GRACE });

    expect(fs.existsSync(caPath('shop'))).to.equal(true);
  });

  it('prunes only the departed app, leaving its neighbours alone', async () => {
    const both = [routeFor('shop', 'required'), routeFor('api', 'required')];
    await provisionBackendCas(both, fetcher, { dir, graceMs: GRACE });
    await ageBy('shop', GRACE + HOUR);
    await ageBy('api', GRACE + HOUR);

    await provisionBackendCas([routeFor('api', 'required')], fetcher, { dir, graceMs: GRACE });

    expect(fs.existsSync(caPath('shop'))).to.equal(false);
    expect(fs.existsSync(caPath('api')), 'still routed, so refreshed not removed').to.equal(true);
  });

  it('ages out an app that downgraded from required to none', async () => {
    await provisionBackendCas([routeFor('shop', 'required')], fetcher, { dir, graceMs: GRACE });
    await ageBy('shop', GRACE + HOUR);

    // verify:none uses the owner's own cert — the platform CA is dead weight now.
    await provisionBackendCas([routeFor('shop', 'none')], fetcher, { dir, graceMs: GRACE });

    expect(fs.existsSync(caPath('shop'))).to.equal(false);
  });

  it('touches nothing that is not a per-app CA file', async () => {
    await fsp.writeFile(path.join(dir, 'ca-certificates.crt'), 'system bundle');
    await fsp.writeFile(path.join(dir, 'notes.txt'), 'unrelated');
    const old = new Date(Date.now() - 90 * 24 * HOUR);
    await fsp.utimes(path.join(dir, 'ca-certificates.crt'), old, old);
    await fsp.utimes(path.join(dir, 'notes.txt'), old, old);

    await provisionBackendCas([], fetcher, { dir, graceMs: GRACE });

    expect(fs.existsSync(path.join(dir, 'ca-certificates.crt'))).to.equal(true);
    expect(fs.existsSync(path.join(dir, 'notes.txt'))).to.equal(true);
  });
});

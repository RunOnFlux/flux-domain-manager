// Before a haproxy config that carries `verify: required` backends can be rendered, each
// such app's own Flux-derived CA has to be on disk — haproxy refuses to load a config that
// names a missing ca-file, and that refusal takes down every app on the director, not just
// the one. This pass runs after the route configs are built and before the render: it
// ensures each required-verify app's per-app CA is present at the path the renderer will
// name, returning the set of app names whose CA is confirmed on disk.
//
// The per-app CA is byte-deterministic and effectively permanent (a fixed ~100-year
// window), so once written it never changes: an app whose CA file already exists is ready
// without a fetch, and only a first appearance touches the crypto service. The write is
// atomic (temp + rename) so a crash can never leave a partial CA that would itself make
// haproxy refuse the config. A fetch or write that fails leaves that one app out of the
// ready set (the renderer then emits no ssl directive for it, so it stays down until its CA
// lands) rather than throwing — one unreachable CA must not stop routing updates for every
// other app on the box.
//
// (If the CA derivation ever gains rotation/revocation — it has none today — this "exists =>
// trust" shortcut needs a versioned flush; noted, out of scope while the CA is immutable.)
//
// The same pass also removes the CAs of apps that are gone. Nothing else ever deletes them,
// and "exists => trust" means they are never rewritten either, so without this the directory
// only grows — one file per app that has ever used required-verify on this director.
const fsp = require('node:fs/promises');
const path = require('node:path');
const config = require('config');

const log = require('../../lib/log');
const { backendCaFileName, BACKEND_CA_DIR } = require('./resolveBackendConfig');

// How long a CA must go unreferenced before it is deleted. The grace period is what makes
// this safe against a bad cycle: a truncated app list, a failed fetch, or an app that
// briefly drops out of the routing view costs nothing, because removal needs the app to be
// continuously absent across a full day of cycles. Read at load like the publish guard's
// tunables, so a config that has drifted out of step fails the director at boot rather than
// throwing mid-cycle, where it would stall routing updates for every app on the box.
const UNUSED_GRACE_MS = config.haproxyRouting.backendCa.unusedGraceHours * 60 * 60 * 1000;

// Written and read by the prune below only. Matches what backendCaFileName produces.
const CA_FILE_RE = /^flux-ca-(.+)\.pem$/;

// The app names whose routes ask for `verify: required`, de-duplicated: one app owns one
// CA no matter how many domains or ports route to it, so it is fetched once.
function requiredVerifyAppNames(routeConfigs) {
  const names = new Set();
  routeConfigs.forEach((rc) => {
    if (rc.backendTls && rc.backendTls.verify === 'required') names.add(rc.name);
  });
  return names;
}

async function fileExists(filePath) {
  return fsp.access(filePath).then(() => true).catch(() => false);
}

// Atomic write: land the bytes on a temp file in the same directory, then rename over the
// target. rename is atomic on one filesystem, so a reader (haproxy) never sees a partial CA.
async function writeAtomic(filePath, contents) {
  const tmp = `${filePath}.tmp`;
  await fsp.writeFile(tmp, contents, { mode: 0o644 });
  await fsp.rename(tmp, filePath);
}

/**
 * Refresh the in-use CAs' liveness marks, then delete any that have gone unreferenced for
 * longer than the grace period.
 *
 * Liveness is the file's own mtime — "last cycle that still needed this CA". Keeping it on
 * disk rather than in memory is what survives the director crashing, being restarted, or
 * being redeployed: an in-memory countdown would either forget a pending removal or restart
 * it from zero on every process start, so a director that restarts often would never prune
 * at all. The marks are refreshed BEFORE anything is deleted, so a director that was down
 * for longer than the grace period does not mistake its own downtime for disuse.
 *
 * Deleting a CA that is still wanted is cheap and self-correcting: the per-app CA is
 * byte-deterministic, so the next cycle that needs it fetches back an identical file.
 *
 * @param {string} dir directory holding the per-app CA files
 * @param {Set<string>} inUse app names still routed with required-verify this cycle. This is
 *   the routing view, NOT the set whose fetch succeeded: an app whose CA is momentarily
 *   unfetchable is still live and must not age out while it is being retried.
 * @param {number} graceMs how long a CA may sit unreferenced before removal
 * @returns {Promise<number>} how many CA files were removed
 */
async function pruneUnusedCas(dir, inUse, graceMs) {
  let entries;
  try {
    entries = await fsp.readdir(dir);
  } catch (err) {
    // No directory yet (no required-verify app has ever routed here) — nothing to prune.
    return 0;
  }

  const now = Date.now();
  const stamp = new Date(now);
  await Promise.all([...inUse].map((appName) => {
    const filePath = path.join(dir, backendCaFileName(appName));
    return fsp.utimes(filePath, stamp, stamp).catch(() => {});
  }));

  let removed = 0;
  await Promise.all(entries.map(async (entry) => {
    const match = CA_FILE_RE.exec(entry);
    if (!match || inUse.has(match[1])) return;
    const filePath = path.join(dir, entry);
    try {
      const { mtimeMs } = await fsp.stat(filePath);
      if (now - mtimeMs < graceMs) return;
      await fsp.unlink(filePath);
      removed += 1;
      log.info(`Removed the backend-TLS CA for ${match[1]}: unreferenced for over ${Math.round(graceMs / 3600000)}h`);
    } catch (err) {
      // A CA we cannot remove is a bounded amount of dead disk, never a routing fault —
      // the renderer only ever names the CAs of apps it is actually routing.
      log.warn(`Could not prune the backend-TLS CA ${entry}: ${err.message}`);
    }
  }));
  return removed;
}

/**
 * Provision the per-app backend-TLS CAs referenced by the route configs, and prune the ones
 * whose apps are long gone.
 * @param {Array<Object>} routeConfigs the resolved route configs about to be rendered
 * @param {{ fetchCaCertificate: (appName: string) => Promise<string> }} fetcher
 * @param {{ dir?: string, graceMs?: number }} [options] dir - where CA files are written
 *   (defaults to the production BACKEND_CA_DIR the renderer names); graceMs - unused-CA
 *   removal delay. Both overridden only in tests.
 * @returns {Promise<Set<string>>} app names whose CA is confirmed on disk
 */
async function provisionBackendCas(routeConfigs, fetcher, options = {}) {
  const dir = options.dir || BACKEND_CA_DIR;
  const graceMs = options.graceMs ?? UNUSED_GRACE_MS;
  const names = requiredVerifyAppNames(routeConfigs);

  const ready = new Set();
  if (names.size) {
    await fsp.mkdir(dir, { recursive: true });

    await Promise.all([...names].map(async (appName) => {
      const filePath = path.join(dir, backendCaFileName(appName));
      try {
        // The CA is immutable, so an existing file is authoritative — no fetch needed.
        if (!await fileExists(filePath)) {
          const pem = await fetcher.fetchCaCertificate(appName);
          await writeAtomic(filePath, pem);
        }
        ready.add(appName);
      } catch (err) {
        // Left out of the ready set on purpose: the renderer will emit no verify directive
        // for this app, so it is unroutable until its CA lands — never routed unverified,
        // never a missing ca-file in the config.
        log.error(`backend-TLS CA not provisioned for ${appName}, leaving it unverified-down this cycle: ${err.message}`);
      }
    }));
  }

  // Outside the guard above on purpose: removing the last required-verify app leaves no
  // names to provision, and that is exactly the cycle whose CA needs to start ageing out.
  await pruneUnusedCas(dir, names, graceMs);

  return ready;
}

module.exports = { provisionBackendCas, requiredVerifyAppNames, pruneUnusedCas };

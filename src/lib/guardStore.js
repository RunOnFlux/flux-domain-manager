/**
 * The last accepted size of each guarded list, kept on disk so that the first
 * list after a restart is judged against what was accepted before it.
 *
 * A missing or unreadable file means nothing has been accepted on this box, and
 * each guard holds its first list to the floor. A pending wait is not kept: it is
 * timed on a monotonic clock that does not carry over to a new process.
 */
const fs = require('node:fs');
const path = require('node:path');
const config = require('config');
const log = require('./log');

function readCounts(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed !== null && typeof parsed === 'object' ? parsed : {};
  } catch (error) {
    if (error.code !== 'ENOENT') {
      log.warn(`list guard state ${filePath} is unreadable; starting without it: ${error.message}`);
    }
    return {};
  }
}

/**
 * @param {string} filePath
 */
function createGuardStore(filePath) {
  const counts = readCounts(filePath);

  return {
    /**
     * @param {string} key
     * @returns {{ lastAcceptedCount: (number|null), pendingSince: null }}
     */
    initialState(key) {
      const saved = counts[key];
      const lastAcceptedCount = Number.isInteger(saved) && saved >= 0 ? saved : null;
      return { lastAcceptedCount, pendingSince: null };
    },

    /**
     * Saves an accepted size. The file is replaced by rename, so a crash leaves
     * the old file or the new one, never a partial one.
     *
     * @param {string} key
     * @param {number} count
     */
    recordAccepted(key, count) {
      if (counts[key] === count) return;
      counts[key] = count;
      const tmpPath = `${filePath}.tmp`;
      try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(tmpPath, JSON.stringify(counts));
        fs.renameSync(tmpPath, filePath);
      } catch (error) {
        log.error(`list guard state not saved to ${filePath}: ${error.message}`);
      }
    },
  };
}

let sharedStore = null;

/** The store at `config.guards.stateFile`, shared by every guard in the process. */
function sharedGuardStore() {
  if (!sharedStore) sharedStore = createGuardStore(config.guards.stateFile);
  return sharedStore;
}

module.exports = {
  createGuardStore,
  sharedGuardStore,
};

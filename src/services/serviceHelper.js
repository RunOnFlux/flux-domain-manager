'use strict';

const qs = require('qs');

/**
 * Sorts an array of IP addresses (both IPv4 and IPv6) with optional ports
 * @param {string[]} addresses - Array of IP addresses to sort
 * @returns {string[]} - Sorted array of IP addresses
 */
function sortIPAddresses(addresses) {
  return addresses.sort((a, b) => {
    const parseAddress = (addr) => {
      let ip;
      let port = 0;

      // Check if IPv6 (contains colons and possibly brackets)
      if (addr.includes('[') && addr.includes(']:')) {
        // IPv6 with port: [2001:41d0:d00:b800::46]:9159
        const match = addr.match(/\[(.*?)\]:(\d+)/);
        if (match) {
          [, ip, port] = match;
          port = parseInt(port, 10);
        }
      } else if (addr.includes(':') && addr.split(':').length > 2) {
        // IPv6 without port
        ip = addr;
      } else if (addr.includes(':')) {
        // IPv4 with port: 95.216.124.210:16774
        const parts = addr.split(':');
        [ip, port] = parts;
        port = parseInt(port, 10);
      } else {
        // IPv4 without port
        ip = addr;
      }

      return { ip, port, isIPv6: ip.includes(':') };
    };

    const addrA = parseAddress(a);
    const addrB = parseAddress(b);

    // Sort IPv4 before IPv6
    if (addrA.isIPv6 !== addrB.isIPv6) {
      return addrA.isIPv6 ? 1 : -1;
    }

    if (!addrA.isIPv6) {
      // Compare IPv4 addresses
      const partsA = addrA.ip.split('.').map(Number);
      const partsB = addrB.ip.split('.').map(Number);

      for (let i = 0; i < 4; i += 1) {
        if (partsA[i] !== partsB[i]) {
          return partsA[i] - partsB[i];
        }
      }
    } else {
      // Compare IPv6 addresses
      const expandIPv6 = (ip) => {
        // Handle :: shorthand
        const sections = ip.split('::');
        let parts;

        if (sections.length === 2) {
          const left = sections[0] ? sections[0].split(':') : [];
          const right = sections[1] ? sections[1].split(':') : [];
          const missing = 8 - left.length - right.length;
          parts = [...left, ...Array(missing).fill('0'), ...right];
        } else {
          parts = ip.split(':');
        }

        // Pad each part with leading zeros
        return parts.map((part) => part.padStart(4, '0'));
      };

      const expandedA = expandIPv6(addrA.ip);
      const expandedB = expandIPv6(addrB.ip);

      for (let i = 0; i < 8; i += 1) {
        const valA = parseInt(expandedA[i], 16);
        const valB = parseInt(expandedB[i], 16);
        if (valA !== valB) {
          return valA - valB;
        }
      }
    }

    // If IPs are equal, sort by port
    return addrA.port - addrB.port;
  });
}

function timeout(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Run tasks with at most `limit` in flight, and report every outcome.
 *
 * Returns settled results in task order - callers read `r.status === 'fulfilled'`
 * - so a task that throws is data, not an abort. Two things are needed to make
 * that true, and neither is decoration:
 *
 * `Promise.resolve().then(task)` rather than `task()`, so a task that throws
 * SYNCHRONOUSLY becomes a rejected promise instead of unwinding this function on
 * the spot, before allSettled is ever reached.
 *
 * `.catch()` on the race, because Promise.race REJECTS as soon as any promise it
 * is watching rejects. Awaiting it bare meant one failing task threw out of the
 * loop: every task not yet started never ran, the caller never got its results,
 * and the promises already created were left with no handler attached - an
 * unhandled rejection, which by default takes the process down. The rejection is
 * not swallowed; it is still carried in `results` and surfaced by allSettled.
 * The race is only being used as a "one slot freed" signal, and a task failing
 * frees a slot exactly as a task succeeding does.
 *
 * @param {Array<function(): Promise<any>>} tasks thunks, invoked here
 * @param {number} limit maximum in flight
 * @returns {Promise<Array<{status: string, value?: any, reason?: any}>>}
 */
async function runWithConcurrency(tasks, limit) {
  const results = [];
  const executing = new Set();
  // eslint-disable-next-line no-restricted-syntax
  for (const task of tasks) {
    // eslint-disable-next-line no-loop-func
    const p = Promise.resolve().then(task).finally(() => executing.delete(p));
    executing.add(p);
    results.push(p);
    if (executing.size >= limit) {
      // eslint-disable-next-line no-await-in-loop
      await Promise.race(executing).catch(() => {});
    }
  }
  return Promise.allSettled(results);
}

function createDataMessage(data) {
  const successMessage = {
    status: 'success',
    data,
  };
  return successMessage;
}

function createSuccessMessage(message, name, code) {
  const successMessage = {
    status: 'success',
    data: {
      code,
      name,
      message,
    },
  };
  return successMessage;
}

function createWarningMessage(message, name, code) {
  const warningMessage = {
    status: 'warning',
    data: {
      code,
      name,
      message,
    },
  };
  return warningMessage;
}

function createErrorMessage(message, name, code) {
  const errMessage = {
    status: 'error',
    data: {
      code,
      name,
      message: message || 'Unknown error',
    },
  };
  return errMessage;
}

function ensureBoolean(parameter) {
  let param;
  if (parameter === 'false' || parameter === 0 || parameter === '0' || parameter === false) {
    param = false;
  }
  if (parameter === 'true' || parameter === 1 || parameter === '1' || parameter === true) {
    param = true;
  }
  return param;
}

function ensureNumber(parameter) {
  return typeof parameter === 'number' ? parameter : Number(parameter);
}

function ensureObject(parameter) {
  if (typeof parameter === 'object') {
    return parameter;
  }
  let param;
  try {
    param = JSON.parse(parameter);
  } catch (e) {
    param = qs.parse(parameter);
  }
  return param;
}

function ensureString(parameter) {
  return typeof parameter === 'string' ? parameter : JSON.stringify(parameter);
}

// Wildcard string comparison with Regex
function matchRule(str, rules) {
  // eslint-disable-next-line no-restricted-syntax
  for (const rule of rules) {
    const escapeRegex = (string) => string.replace(/([.*+?^=!:${}()|[\]/\\])/g, '\\$1');
    if (new RegExp(`^${rule.split('*').map(escapeRegex).join('.*')}$`).test(str) === true) return true;
  }
  return false;
}

// Flatten several iterables (Map keys/values, arrays, ...) into one array — e.g.
// the union of the active-standby and active-active app groups, so callers read
// them as a single collection instead of spreading each group inline.
function concatIterables(...iterables) {
  return iterables.flatMap((iterable) => [...iterable]);
}

module.exports = {
  timeout,
  ensureBoolean,
  ensureNumber,
  ensureObject,
  ensureString,
  createDataMessage,
  createSuccessMessage,
  createWarningMessage,
  createErrorMessage,
  matchRule,
  sortIPAddresses,
  runWithConcurrency,
  concatIterables,
};

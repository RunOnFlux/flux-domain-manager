const mongodb = require('mongodb');
const config = require('config');
const qs = require('qs');
const axios = require('axios');

const { MongoClient } = mongodb;
const mongoUrl = `mongodb://${config.database.url}:${config.database.port}/`;

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

async function httpGetRequest(url, awaitTime = 30000, headers = {}, httpsAgent) {
  const { CancelToken } = axios;
  const source = CancelToken.source();
  let isResolved = false;
  setTimeout(() => {
    if (!isResolved) {
      source.cancel('Operation canceled');
    }
  }, awaitTime * 2);
  const options = {
    cancelToken: source.token,
    timeout: awaitTime,
    headers,
  };
  if (httpsAgent) {
    options.httpsAgent = httpsAgent;
  }
  const response = await axios.get(url, options);
  isResolved = true;
  return response;
}

async function httpPostRequest(url, data, awaitTime = 30000, headers = {}, httpsAgent) {
  const { CancelToken } = axios;
  const source = CancelToken.source();
  let isResolved = false;
  setTimeout(() => {
    if (!isResolved) {
      source.cancel('Operation canceled');
    }
  }, awaitTime * 2);
  const options = {
    cancelToken: source.token,
    timeout: awaitTime,
    headers,
  };
  if (httpsAgent) {
    options.httpsAgent = httpsAgent;
  }
  const response = await axios.post(url, data, options);
  isResolved = true;
  return response;
}

function timeout(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
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

/**
 * Check if an app is a UDP/TCP game that should use direct DNS routing
 * Games use direct DNS routing to primary IP for better latency
 * This should ONLY be used for G mode apps (apps with g: in containerData)
 * @param {string} appName - The name of the application
 * @param {string[]} gameTypes - Array of game type prefixes from config
 * @param {Object} [appSpec] - Optional: full app specification to verify G mode
 * @returns {boolean} True if app is a game that needs direct routing
 */
function isUDPGameApp(appName, gameTypes, appSpec = null) {
  // If app spec provided, verify it's actually a G mode app
  if (appSpec) {
    let hasGMode = false;
    if (appSpec.version <= 3) {
      hasGMode = appSpec.containerData && appSpec.containerData.includes('g:');
    } else if (appSpec.compose) {
      hasGMode = appSpec.compose.some((comp) => comp.containerData && comp.containerData.includes('g:'));
    }
    // If not G mode, definitely not a game app for this feature
    if (!hasGMode) {
      return false;
    }
  }

  const lowerName = appName.toLowerCase();
  // eslint-disable-next-line no-restricted-syntax
  for (const gameType of gameTypes) {
    if (lowerName.startsWith(gameType.toLowerCase())) {
      return true;
    }
  }
  return false;
}

// MongoDB functions
async function connectMongoDb(url) {
  const connectUrl = url || mongoUrl;
  const mongoSettings = {
    maxPoolSize: 100,
  };
  const db = await MongoClient.connect(connectUrl, mongoSettings).catch((error) => { throw error; });
  return db;
}

async function findInDatabase(database, collection, query, projection) {
  const results = await database.collection(collection).find(query, projection).toArray().catch((error) => { throw error; });
  return results;
}

async function findOneInDatabaseReverse(database, collection, query, projection) {
  const result = await database.collection(collection).find(query, projection).sort({ _id: -1 }).limit(1)
    .next()
    .catch((error) => { throw error; });
  return result;
}

async function findOneInDatabase(database, collection, query, projection) {
  const result = await database.collection(collection).findOne(query, projection).catch((error) => { throw error; });
  return result;
}

async function findOneAndUpdateInDatabase(database, collection, query, update, options) {
  const passedOptions = options || {};
  const result = await database.collection(collection).findOneAndUpdate(query, update, passedOptions).catch((error) => { throw error; });
  return result;
}

async function insertOneToDatabase(database, collection, value) {
  const result = await database.collection(collection).insertOne(value).catch((error) => { throw error; });
  return result;
}

async function updateOneInDatabase(database, collection, query, value) {
  const result = await database.collection(collection).updateOne(query, { $set: value }).catch((error) => { throw error; });
  return result;
}

async function updateInDatabase(database, collection, query, projection) {
  const result = await database.collection(collection).updateMany(query, projection).catch((error) => { throw error; });
  return result;
}

async function findOneAndDeleteInDatabase(database, collection, query, projection) {
  const result = await database.collection(collection).findOneAndDelete(query, projection).catch((error) => { throw error; });
  return result;
}

async function removeDocumentsFromCollection(database, collection, query) {
  // to remove all documents from collection, the query is just {}
  const result = await database.collection(collection).deleteMany(query).catch((error) => { throw error; });
  return result;
}

async function dropCollection(database, collection) {
  const result = await database.collection(collection).drop().catch((error) => { throw error; });
  return result;
}

async function collectionStats(database, collection) {
  // to remove all documents from collection, the query is just {}
  const result = await database.collection(collection).stats().catch((error) => { throw error; });
  return result;
}

module.exports = {
  httpGetRequest,
  httpPostRequest,
  timeout,
  ensureBoolean,
  ensureNumber,
  ensureObject,
  ensureString,
  connectMongoDb,
  findInDatabase,
  findOneInDatabaseReverse,
  findOneInDatabase,
  findOneAndUpdateInDatabase,
  insertOneToDatabase,
  updateInDatabase,
  updateOneInDatabase,
  findOneAndDeleteInDatabase,
  removeDocumentsFromCollection,
  dropCollection,
  collectionStats,
  createDataMessage,
  createSuccessMessage,
  createWarningMessage,
  createErrorMessage,
  matchRule,
  sortIPAddresses,
  isUDPGameApp,
};

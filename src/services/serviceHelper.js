const mongodb = require('mongodb');
const config = require('config');
const qs = require('qs');
const axios = require('axios');

const { MongoClient } = mongodb;
const mongoUrl = `mongodb://${config.database.url}:${config.database.port}/`;

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

// MongoDB functions
async function connectMongoDb(url) {
  const connectUrl = url || mongoUrl;
  const mongoSettings = {
    useNewUrlParser: true,
    useUnifiedTopology: true,
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
};

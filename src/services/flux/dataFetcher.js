const crypto = require('node:crypto');
const fs = require('node:fs');
const https = require('node:https');
const { EventEmitter } = require('node:events');
const TTLCache = require('@isaacs/ttlcache');
const url = require('node:url');

const axios = require('axios');

// const log = require('./log');
const log = require('../../lib/log');

/**
 * @typedef {{}} AppSpec
 */

/**
 * @typedef {Array<AppSpec>} AppSpecList
 */

/**
 * @typedef {{
 *   etag: string,
 *   maxAge: number,
 *   specs: AppSpecList | null
 * }} ParsedResponse
 */

class FdmDataFetcher extends EventEmitter {
  // As of 17/07/25 the full spec list is 668191 bytes (0.67Mb)

  /**
   * @type {axios.AxiosInstance}
   */
  #fluxApi;

  /**
   * @type {axios.AxiosInstance}
   */
  #sasApi;

  #aborted = false;

  #cache = new TTLCache({ max: 1000, ttl: 86_400_000 });

  endpoints = {
    globalAppSpecs: {
      name: 'globalAppSpecs',
      url: 'apps/globalappsspecifications',
      sha: '',
      etag: '',
      maxAgeMs: 0,
      defaultFetchMs: 30_000,
      /**
       * @type {NodeJS.Timeout | null}
       */
      timeout: null,
    },
    permMessages: {
      name: 'permMessages',
      url: 'apps/permanentmessages',
      options: {
        decompress: true,
        headers: { 'Accept-Encoding': 'gzip, compress, deflate, br' },
      },
      sha: '',
      etag: '',
      maxAgeMs: 0,
      defaultFetchMs: 120_000,
      /**
       * @type {NodeJS.Timeout | null}
       */
      timeout: null,
    },
    sasDecrypt: {
      url: 'decryptMessageRSA',
    },
  };

  /**
   *
   * @param {{
   *   keyPath: string,
   *   certPath: string,
   *   caPath: string,
   *   fluxApiBaseUrl: string,
   *   sasApiBaseUrl: string}} options
   */
  constructor(options) {
    super();

    const {
      keyPath, certPath, caPath, fluxApiBaseUrl, sasApiBaseUrl,
    } = options;

    this.#fluxApi = axios.create({
      baseURL: fluxApiBaseUrl,
      timeout: 30_000,
    });

    this.#sasApi = axios.create({
      baseURL: sasApiBaseUrl,
      timeout: 10_000,
      httpsAgent: new https.Agent({
        key: fs.readFileSync(keyPath),
        cert: fs.readFileSync(certPath),
        ca: fs.readFileSync(caPath),
      }),
    });
  }

  static parseJson(data) {
    try {
      return JSON.parse(data);
    } catch {
      return null;
    }
  }

  /**
   * This is ugly. We only have to do this because the frontend passes arrays as strings
   *
   * @param {Object} blob
   */
  static hydrate(blob) {
    const parsed = {};

    // eslint-disable-next-line no-restricted-syntax
    for (const [key, value] of Object.entries(blob)) {
      if (value instanceof Array) {
        parsed[key] = value.map((item) => this.hydrate(item));
      } else if (value.startsWith('[') && value.endsWith(']')) {
        parsed[key] = this.parseJson(value);
      } else {
        parsed[key] = value;
      }
    }

    return parsed;
  }

  /**
   * If the passed in specification uses the g: parameter
   * @param {Object} spec
   * @returns {boolean}
   */
  static #isGApp(spec) {
    const matcher = spec.version <= 3
      ? () => spec.containerData.includes('g:')
      : () => spec.compose.some((comp) => comp.containerData.includes('g:'));

    const match = matcher();

    return match;
  }

  /**
   * We shouldn't be allowing these things in domains on the actual
   * app spec. Removing them here makes no sense at all. The old
   * version of this was broken also
   *
   * @param {Object} spec
   */
  static #buildFqdnMap(spec) {
    const components = spec.version <= 3
      ? [{ ports: spec.ports, domains: spec.domains }]
      : spec.compose;

    const fqdns = [];

    components.forEach((comp) => {
      for (let i = 0; i < comp.ports.length; i += 1) {
        const portDomains = comp.domains[i].split(',');
        portDomains.forEach((portDomain) => {
          fqdns.push(portDomain
            .replace('https://', '')
            .replace('http://', '')
            .replace(/[&/\\#,+()$~%'":*?<>{}]/g, '')
            .toLowerCase());
        });
      }
    });

    const domainMap = { name: spec.name, fqdns };

    return domainMap;
  }

  static async sleep(ms) {
    await new Promise((r) => { setTimeout(r, ms); });
  }

  static timestamp() {
    const formattedTime = new Date().toISOString().replace(/\.\d+Z?/, '');

    return formattedTime;
  }

  /**
   * Decrypts content with aes key
   * @param {string} appName application name.
   * @param {Buffer} nonceCiphertextTag base64 encoded encrypted data
   * @param {string} base64AesKey base64 encoded AesKey
   * @returns {any} decrypted data
   */
  static decryptAesData(appName, nonceCiphertextTag, base64AesKey) {
    try {
      const key = Buffer.from(base64AesKey, 'base64');

      const nonce = nonceCiphertextTag.subarray(0, 12);
      const ciphertext = nonceCiphertextTag.subarray(12, -16);
      const tag = nonceCiphertextTag.subarray(-16);

      const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
      decipher.setAuthTag(tag);

      const decrypted = decipher.update(ciphertext, '', 'utf8') + decipher.final('utf8');

      return decrypted;
    } catch (error) {
      log.error(`Error decrypting ${appName}`);
      return null;
    }
  }

  /**
   *
   * @param {axios.AxiosResponse} response
   * @param {{head?: boolean}} options head - If the request is a head request
   * @returns {ParsedResponse | null}
   */
  static #parseAxiosResponse(response, options = {}) {
    const head = options.head ?? false;

    if (!response) return null;

    const { status, headers, data } = response;

    if (status !== 200) {
      log.info(`2XX status code recieved: ${status}, but not 200, skipping`);
      return null;
    }

    const { etag, 'cache-control': cacheControl, fluxnode: backend } = headers;
    const parsedUrl = url.parse(response.config.url);
    console.log(parsedUrl.path, 'IS HEAD', head, 'cache-control', cacheControl);
    const { maxAge } = /^max-age=(?<maxAge>\d+)$/.exec(cacheControl).groups;

    // this is assuming that max-age is always present

    const parsed = {
      etag,
      maxAgeMs: Number(maxAge) * 1_000,
      backend,
      payload: null,
    };

    if (head) return parsed;

    if (!data) return parsed;

    const { status: payloadStatus, data: payloadData } = data;

    if (payloadStatus !== 'success') {
      log.info(
        'HTTP response was fine, but payload status was not '
          + `success: ${payloadStatus}. Skipping`,
      );

      return parsed;
    }

    if (payloadData) parsed.payload = payloadData;

    return parsed;
  }

  static get now() {
    return process.hrtime.bigint();
  }

  async #decryptAppSpec(appSpec) {
    // handle no enterprise?
    const spec = appSpec;
    const { enterprise } = appSpec;
    const { sasDecrypt } = this.endpoints;

    const cacheSpec = this.#cache.get(spec.hash);

    if (cacheSpec) {
      console.log(`Encrypted App spec: ${spec.name}, found in cache, no need to fetch`);
      return cacheSpec;
    }

    let originalOwner = this.#cache.get(spec.name);
    let ownerAttempts = 0;

    while (ownerAttempts < 3) {
      const endpoint = `apps/apporiginalowner/${spec.name}`;
      // eslint-disable-next-line no-await-in-loop
      const fluxRes = await this.#fluxApi.get(endpoint).catch((err) => {
        log.warning('Unable to get app original owner for '
          + `${spec.name}. ${err.message}`);

        return null;
      });

      if (!fluxRes) {
        ownerAttempts += 1;
        // eslint-disable-next-line no-await-in-loop
        await FdmDataFetcher.sleep(3_000);
        // eslint-disable-next-line no-continue
        continue;
      }

      const parsedFluxRes = FdmDataFetcher.#parseAxiosResponse(fluxRes);

      if (!parsedFluxRes) {
        ownerAttempts += 1;
        // eslint-disable-next-line no-await-in-loop
        await FdmDataFetcher.sleep(3_000);
        // eslint-disable-next-line no-continue
        continue;
      }

      ({ payload: originalOwner = '' } = parsedFluxRes);

      if (originalOwner) {
        this.#cache.set(spec.name, originalOwner);
        break;
      }

      console.log(`Owner fetch for: ${spec.name} failed, retrying in 3 seconds`);
      ownerAttempts += 1;
      // eslint-disable-next-line no-await-in-loop
      await FdmDataFetcher.sleep(3_000);
    }

    // we tried 3 times... can't connect to flux api, bail
    if (!originalOwner) return null;

    const enterpriseBuf = Buffer.from(enterprise, 'base64');
    const aesKeyEncrypted = enterpriseBuf.subarray(0, 256);
    const nonceCiphertextTag = enterpriseBuf.subarray(256);

    const base64EncryptedAesKey = aesKeyEncrypted.toString('base64');

    const payload = {
      fluxID: originalOwner,
      appName: spec.name,
      message: base64EncryptedAesKey,
      blockHeight: 9999999,
    };

    let decryptKeyAttempts = 0;
    let base64AesKey = '';

    while (decryptKeyAttempts < 4) {
      // eslint-disable-next-line no-await-in-loop
      const response = await this.#sasApi.post(sasDecrypt.url, payload).catch((err) => {
        log.warning(`Unable to contact sas to decrypt ${spec.name}. ${err.message}`
          + `${spec.name}. ${err.message}`);

        return null;
      });

      // we wait 16 seconds here (instead of 15) as the check loop on keepalived
      // is 30 seconds. So at max we would wait 2 cycles if nginx is down, and it
      // needs to be taken out of the server pool
      if (!response) {
        console.log(`Decrypt AES key call for: ${spec.name} failed, retrying in 16 seconds`);

        decryptKeyAttempts += 1;
        // eslint-disable-next-line no-await-in-loop
        await FdmDataFetcher.sleep(16_000);
        // eslint-disable-next-line no-continue
        continue;
      }

      const { status: responseStatus, data: responseData } = response;

      if (responseStatus !== 200) {
        decryptKeyAttempts += 1;
        // eslint-disable-next-line no-await-in-loop
        await FdmDataFetcher.sleep(16_000);
        // eslint-disable-next-line no-continue
        continue;
      }

      const { status: payloadStatus, message: _base64AesKey } = responseData;

      // we made contact with the sas, but it didn't like our request :(
      if (payloadStatus !== 'ok') return null;

      base64AesKey = _base64AesKey;

      if (base64AesKey) break;

      // shouldn't end up here

      console.log(`Base64AesKey not found for: ${spec.name}, retrying in 16 seconds`);
      decryptKeyAttempts += 1;
      // eslint-disable-next-line no-await-in-loop
      await FdmDataFetcher.sleep(16_000);
    }

    if (!base64AesKey) return null;

    const decrypted = FdmDataFetcher.decryptAesData(
      spec.name,
      nonceCiphertextTag,
      base64AesKey,
    );

    if (!decrypted) return null;

    const parsed = FdmDataFetcher.parseJson(decrypted);

    if (!parsed) return null;

    const hydrated = FdmDataFetcher.hydrate(parsed);

    spec.compose = hydrated.compose;
    spec.contacts = hydrated.contacts;
    // I don't like doing this. As we can no longer tell if it's enterprise
    // or not. However, it's saving memory, and makes the add to map easier.
    // There should really be another boolean field
    spec.enterprise = '';

    this.#cache.set(spec.hash, spec);

    return spec;
  }

  async loop(runner, dataStore) {
    const store = dataStore;

    const ms = await runner();

    if (this.#aborted) return;

    store.timeout = setTimeout(() => this.loop(runner, store), ms);
  }

  startAppSpecLoop() {
    const { globalAppSpecs } = this.endpoints;

    const runner = this.appSpecRunner.bind(this);

    setImmediate(() => this.loop(runner, globalAppSpecs));
  }

  startPermMessagesLoop() {
    const { permMessages } = this.endpoints;

    const runner = this.permMessageRunner.bind(this);

    setImmediate(() => this.loop(runner, permMessages));
  }

  stopAppSpecLoop() {
    // do other stuff here
    const { globalAppSpecs } = this.endpoints;

    clearTimeout(globalAppSpecs.timeout);
    globalAppSpecs.timeout = null;
  }

  stopPermMessagesLoop() {
    // do other stuff here
    const { permMessages } = this.endpoints;

    clearTimeout(permMessages.timeout);
    permMessages.timeout = null;
  }

  static async getHttpCacheValues(store, fetcher) {
    const headRes = await fetcher();

    if (!headRes) return store.defaultFetchMs;

    const {
      etag = null,
      maxAgeMs = store.defaultFetchMs,
      backend = null,
    } = headRes;

    const logger = {
      name: store.name,
      verb: 'head',
      backend,
      etag,
      sameEtag: etag === store.etag,
      maxAgeMs,
      timestamp: FdmDataFetcher.timestamp(),
    };

    console.log(logger);

    if (maxAgeMs === 0) {
      // the origin server is saying the cached could be stale, so we try
      // again in 5 seconds
      return 5_000;
    }

    if (etag && etag === store.etag) {
      return maxAgeMs;
    }

    return 0;
  }

  async processPermMessages(messages) {
    // do processing here instead of filtering elsewhere
    this.emit('permMessagesUpdated', messages);
  }

  async processAppSpecs(specs) {
    // fix these riduculous names
    const gAppsMap = new Map();
    const nonGAppsMap = new Map();
    const appFqdns = [];
    const enterpriseApps = [];

    const specMapper = (_specs) => {
      _specs.forEach((spec) => {
        const { version, enterprise } = spec;

        const isEnterprise = Boolean(version >= 8 && enterprise);

        if (isEnterprise) {
          enterpriseApps.push(spec);
          return;
        }

        const isGApp = FdmDataFetcher.#isGApp(spec);
        const appMap = isGApp ? gAppsMap : nonGAppsMap;

        appMap.set(spec.name, spec);

        const fqdns = FdmDataFetcher.#buildFqdnMap(spec);
        appFqdns.push(fqdns);
      });
    };

    specMapper(specs);

    const logger = () => ({
      GApps: gAppsMap.size,
      NonGApps: nonGAppsMap.size,
      Enterprise: enterpriseApps.length,
      Total: gAppsMap.size + nonGAppsMap.size,
    });

    console.log('Before decryption:\n', logger());

    const decryptPromises = enterpriseApps.map((spec) => this.#decryptAppSpec(spec));

    // these don't reject
    const decryptedSpecs = await Promise.all(decryptPromises);

    specMapper(decryptedSpecs);
    // console.log(util.inspect(decryptedSpecs, { colors: true, depth: null }));

    console.log('After decryption:\n', logger());

    this.emit('appSpecsUpdated', { gApps: gAppsMap, nonGApps: nonGAppsMap, appFqdns });
  }

  async getAndProcessPermMessages() {
    const { permMessages } = this.endpoints;

    const getRes = await this.doPermMessagesHttpGet();
    if (!getRes) return permMessages.defaultFetchMs;

    const {
      payload, etag, maxAgeMs, backend,
    } = getRes;

    permMessages.etag = etag;
    permMessages.maxAgeMs = maxAgeMs;

    const fetchTime = FdmDataFetcher.now;

    // we could get the response as text and hash that, but it changes
    // the logic quite a bit. So a better compromise is to stringify again
    // until the load balancers are fixed (return same api endpoint, i.e. same etag)
    const hasher = crypto.createHash('sha1');
    const specSha = hasher.update(JSON.stringify(payload)).digest('hex');

    if (specSha !== permMessages.sha) {
      console.log('permMessages have a different SHA... processing');
      permMessages.sha = specSha;
      await this.processPermMessages(payload);
    }

    const elapsedMs = Number(FdmDataFetcher.now - fetchTime) / 1_000_000;
    const sleepTimeMs = Math.max(0, maxAgeMs - elapsedMs);

    const logger = {
      name: 'permMessages',
      verb: 'get',
      backend,
      etag,
      specSize: payload ? payload.length : 0,
      sleepTimeMs,
      timestamp: FdmDataFetcher.timestamp(),
    };
    console.log(logger);

    return sleepTimeMs;
  }

  async getAndProcessAppSpecs() {
    const { globalAppSpecs } = this.endpoints;

    const getRes = await this.doAppSpecsHttpGet();
    if (!getRes) return globalAppSpecs.defaultFetchMs;

    const {
      payload, etag, maxAgeMs, backend,
    } = getRes;

    globalAppSpecs.etag = etag;
    globalAppSpecs.maxAgeMs = maxAgeMs;

    const fetchTime = FdmDataFetcher.now;

    // we could get the response as text and hash that, but it changes
    // the logic quite a bit. So a better compromise is to stringify again
    // until the load balancers are fixed (return same api endpoint, i.e. same etag)
    const hasher = crypto.createHash('sha1');
    const specSha = hasher.update(JSON.stringify(payload)).digest('hex');

    if (specSha !== globalAppSpecs.sha) {
      console.log('globalAppSpecs have a different SHA... processing');
      globalAppSpecs.sha = specSha;
      await this.processAppSpecs(payload);
    }

    const elapsedMs = Number(FdmDataFetcher.now - fetchTime) / 1_000_000;
    const sleepTimeMs = Math.max(0, maxAgeMs - elapsedMs);

    const logger = {
      name: 'globalAppSpecs',
      verb: 'get',
      backend,
      etag,
      specSize: payload ? payload.length : 0,
      sleepTimeMs,
      timestamp: FdmDataFetcher.timestamp(),
    };
    console.log(logger);

    return sleepTimeMs;
  }

  /**
   *
   * @returns {Promise<>}
   */
  async doPermMessagesHttpHead() {
    const response = await this.#fluxApi
      .head(this.endpoints.permMessages.url)
      .catch((err) => {
        log.info(`Unable to do HTTP HEAD for app specs: ${err.message}`);
        return null;
      });

    const parsed = FdmDataFetcher.#parseAxiosResponse(response, {
      head: true,
    });

    return parsed;
  }

  /**
   *
   * @returns {Promise<>}
   */
  async doAppSpecsHttpHead() {
    const response = await this.#fluxApi
      .head(this.endpoints.globalAppSpecs.url)
      .catch((err) => {
        log.info(`Unable to do HTTP HEAD for app specs: ${err.message}`);

        return null;
      });

    const parsed = FdmDataFetcher.#parseAxiosResponse(response, {
      head: true,
    });

    return parsed;
  }

  async doAppSpecsHttpGet() {
    const response = await this.#fluxApi
      .get(this.endpoints.globalAppSpecs.url)
      .catch((err) => {
        log.info(`Unable to do HTTP GET for app specs: ${err.message}`);
        return null;
      });

    const parsed = FdmDataFetcher.#parseAxiosResponse(response);

    return parsed;
  }

  async doPermMessagesHttpGet() {
    // we get the compressed output. 56Mb vs 11Mb
    // this is still ridiculous though - we don't need to fetch the entire
    // message list every time
    const { permMessages: options } = this.endpoints;

    const response = await this.#fluxApi
      .get(this.endpoints.permMessages.url, options)
      .catch((err) => {
        log.info(`Unable to do HTTP GET for app specs: ${err.message}`);
        return null;
      });

    const parsed = FdmDataFetcher.#parseAxiosResponse(response);

    return parsed;
  }

  /**
   * Checks the latest specs via ETAG, if different, runs a GET.
   * @returns {Promise<number>} Ms until next loop time
   */
  async appSpecRunner() {
    const { globalAppSpecs } = this.endpoints;

    if (globalAppSpecs.etag) {
      const store = globalAppSpecs;
      const fetcher = this.doAppSpecsHttpHead.bind(this);

      const cacheMaxAgeMs = await FdmDataFetcher.getHttpCacheValues(store, fetcher);

      if (cacheMaxAgeMs) return cacheMaxAgeMs;
    }

    const getMaxAgeMs = await this.getAndProcessAppSpecs();

    return getMaxAgeMs;
  }

  /**
   * Checks the latest permanent messages via ETAG, if different, runs a GET.
   * @returns {Promise<number>} Ms until next loop time
   */
  async permMessageRunner() {
    const { permMessages } = this.endpoints;

    if (permMessages.etag) {
      const store = permMessages;
      const fetcher = this.doPermMessagesHttpHead.bind(this);
      const cacheMaxAgeMs = await FdmDataFetcher.getHttpCacheValues(store, fetcher);

      if (cacheMaxAgeMs) return cacheMaxAgeMs;
    }

    const getMaxAgeMs = await this.getAndProcessPermMessages();

    return getMaxAgeMs;
  }
}

async function main() {
  const specFetcher = new FdmDataFetcher({
    keyPath: '/root/fdm-arcane-specs/fdm-eu-2-1.key',
    certPath: '/root/fdm-arcane-specs/fdm-eu-2-1.pem',
    caPath: '/root/fdm-arcane-specs/ca.pem',
    fluxApiBaseUrl: 'https://api.runonflux.io/',
    sasApiBaseUrl: 'https://10.100.0.170/api/',
  });

  specFetcher.startAppSpecLoop();
  specFetcher.startPermMessagesLoop();
  specFetcher.on('appSpecsUpdated', (specs) => console.log(
    'Received appSpecsUpdated event with spec sizes:',
    specs.gApps.size,
    specs.nonGApps.size,
  ));
  specFetcher.on('permMessagesUpdated', (messages) => console.log(
    'Received permMessagesUpdated event with spec size:',
    messages.length,
  ));
}

module.exports = { FdmDataFetcher };

if (require.main === module) {
  main();
}

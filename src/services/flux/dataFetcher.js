'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const { EventEmitter } = require('node:events');
const TTLCache = require('@isaacs/ttlcache');

const config = require('config');
const { runWithConcurrency } = require('../serviceHelper');
const { createHttpClient } = require('../../lib/outbound');
const { evaluateListChange } = require('../../lib/listGuard');
const { sharedGuardStore } = require('../../lib/guardStore');
const alerts = require('../alertService');

// const log = require('./log');
const log = require('../../lib/log');
const { ConditionLog } = require('../conditionLog');
const specLibs = require('./specLibs');
const { registerSpecDecryptProviders } = require('./specDecrypt');
const { requestCaCertificate } = require('./caCertificate');

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

// Conditions a fetch or a spec can be in for many polls in a row: logged when they
// start and when they clear.
const fetchFailures = new ConditionLog({ level: 'info' });
const undecryptable = new ConditionLog();
const unresolvableSpecs = new ConditionLog({ level: 'error' });
const failingLoops = new ConditionLog({ level: 'error' });

class FdmDataFetcher extends EventEmitter {
  // As of 17/07/25 the full spec list is 668191 bytes (0.67Mb)

  /**
   * @type {import('axios').AxiosInstance}
   */
  #fluxApi;

  /**
   * @type {import('axios').AxiosInstance}
   */
  #cryptoApi;

  /**
   * @type {{ rsaDecrypt: string, gcmDecrypt: string, caCertificate: string }}
   */
  #cryptoEndpoints;

  /**
   * Memoized promise for the one-time decrypt-provider registration.
   * @type {Promise<void> | null}
   */
  #providersReady = null;

  #guardStore;

  #specListGuard;

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
    appsLocations: {
      name: 'appsLocations',
      url: 'apps/locations',
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
  };

  /**
   *
   * @param {{
   *   keyPath: string,
   *   certPath: string,
   *   caPath: string,
   *   fluxApiBaseUrl: string,
   *   cryptoService: { baseUrl: string, rsaDecryptPath: string, gcmDecryptPath: string,
   *     caCertificatePath: string }}} options
   */
  constructor(options) {
    super();

    const {
      keyPath, certPath, caPath, fluxApiBaseUrl, cryptoService, guardStore,
    } = options;

    this.#guardStore = guardStore ?? sharedGuardStore();
    this.#specListGuard = this.#guardStore.initialState('specList');

    this.#fluxApi = createHttpClient({
      baseURL: fluxApiBaseUrl,
      timeoutMs: 30_000,
    });

    this.#cryptoApi = createHttpClient({
      baseURL: cryptoService.baseUrl,
      timeoutMs: 10_000,
      tls: {
        key: fs.readFileSync(keyPath),
        cert: fs.readFileSync(certPath),
        ca: fs.readFileSync(caPath),
      },
    });

    this.#cryptoEndpoints = {
      rsaDecrypt: cryptoService.rsaDecryptPath,
      gcmDecrypt: cryptoService.gcmDecryptPath,
      caCertificate: cryptoService.caCertificatePath,
    };
  }

  /**
   * Whether a fetched spec list may replace the current one.
   *
   * A backend rebuilding its app registry answers `success` with an empty or
   * partial list. Accepted, it empties the app maps and every haproxy config
   * built from them. A refused list changes nothing - not the maps, and not the
   * stored etag, so the next poll fetches again. The rule is lib/listGuard's.
   *
   * @param {unknown} payload
   * @param {string} backend the api.runonflux.io backend that answered
   * @param {string} etag
   * @returns {boolean}
   */
  #admitSpecList(payload, backend, etag) {
    const { specList } = config.guards;
    const lastAccepted = this.#specListGuard.lastAcceptedCount;

    let verdict;
    if (Array.isArray(payload)) {
      const nowMs = Number(FdmDataFetcher.now / 1_000_000n);
      verdict = evaluateListChange(payload.length, this.#specListGuard, specList, nowMs);
      this.#specListGuard = verdict.state;
    } else {
      verdict = { accept: false, reason: 'malformed' };
    }

    if (!verdict.accept) {
      const count = Array.isArray(payload) ? payload.length : 'no';
      alerts.raise(
        'spec-refused',
        `refused spec list: ${count} specs (last accepted ${lastAccepted ?? 'none'}), `
        + `reason ${verdict.reason}, backend ${backend}, etag ${etag}`,
        { afterMs: specList.alertAfterMs },
      );
      return false;
    }

    if (verdict.reason === 'confirmed') {
      log.warn(`spec list of ${payload.length} (last accepted ${lastAccepted ?? 'none'}) held `
        + `for ${Math.round(specList.confirmMs / 1000)}s; accepting it`);
    }
    this.#guardStore.recordAccepted('specList', payload.length);
    alerts.resolve('spec-refused');
    return true;
  }

  static parseJson(data) {
    try {
      return JSON.parse(data);
    } catch {
      return null;
    }
  }

  /**
   * Register the version-specific decrypt providers on the flux-spec EncryptedSpec
   * classes, once. `EncryptedSpec.decrypt()` then dispatches to the right one by
   * version. Memoized — the registration is a one-time global side effect.
   * @returns {Promise<void>}
   */
  #ensureProviders() {
    if (!this.#providersReady) {
      const { rsaDecrypt, gcmDecrypt } = this.#cryptoEndpoints;
      this.#providersReady = registerSpecDecryptProviders({
        http: this.#cryptoApi,
        endpoints: { rsaDecrypt, gcmDecrypt },
      });
    }
    return this.#providersReady;
  }

  /**
   * Fetch an app's backend-TLS CA certificate over the same mTLS channel used for spec
   * decryption. The CA is the identity's and is byte-deterministic across the fleet, so
   * the returned PEM is stable — a caller may cache it and treat writes as idempotent.
   * Only meaningful for apps whose backendTls is `verify: required`; the caller decides
   * when to ask.
   *
   * @param {string} appName
   * @param {string} identity the identity the app's registration minted
   * @returns {Promise<string>} the CA certificate in PEM
   */
  async fetchCaCertificate(appName, identity) {
    const certificate = await requestCaCertificate({
      http: this.#cryptoApi,
      endpoint: this.#cryptoEndpoints.caCertificate,
      appName,
      identity,
    });
    return certificate;
  }

  /**
   * The custom-domain FQDNs an app claims, drawn from its resolved loadBalancing so
   * every version is covered uniformly. Feeds the cross-app ownership check. Domains
   * are stripped of protocol and characters HAProxy can't carry and lowercased to
   * match how the ownership check looks them up; empty entries are dropped (they never
   * match a real domain).
   *
   * @param {Object} deployment a resolved DeploymentSpec
   * @param {string} name the app name
   */
  static #buildFqdnMap(deployment, name) {
    const fqdns = deployment.routes('haproxy')
      .flatMap((route) => route.customDomains || [])
      .map((domain) => domain.replace(/https?:\/\/|[&/\\#,+()$~%'":*?<>{}]/g, '').toLowerCase())
      .filter((fqdn) => fqdn !== '');

    return { name, fqdns };
  }

  static timestamp() {
    const formattedTime = new Date().toISOString().replace(/\.\d+Z?/, '');

    return formattedTime;
  }

  /**
   *
   * @param {import('axios').AxiosResponse} response
   * @param {{head?: boolean}} options head - If the request is a head request
   * @returns {ParsedResponse | null}
   */
  static #parseAxiosResponse(response, options = {}) {
    const head = options.head ?? false;

    if (!response) return null;

    const { status, headers, data } = response;

    const endpoint = options.endpoint || 'flux api';
    fetchFailures.report(`${endpoint}:status`, status !== 200, () => `${endpoint}: 2XX status code received: ${status}, but not 200, skipping`);
    if (status !== 200) return null;

    const { etag, 'cache-control': cacheControl, fluxnode: backend } = headers;
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

    fetchFailures.report(`${endpoint}:payload`, payloadStatus !== 'success', () => `${endpoint}: HTTP response was fine, but payload status was not success: ${payloadStatus}. Skipping`);
    if (payloadStatus !== 'success') return parsed;

    if (payloadData) parsed.payload = payloadData;

    return parsed;
  }

  static get now() {
    return process.hrtime.bigint();
  }

  /**
   * Read one sealed spec, and hand back the readable spec object the rest of the
   * pipeline routes from.
   *
   * The result is an object, not a document. A decrypted spec has no wire form —
   * flux-spec seals `serialize()` on it, so the only route from decrypted content back
   * to bytes is re-encryption — and FDM never needed one: every consumer resolves a
   * DeploymentSpec, and `DeploymentSpec.fromSpec` takes a readable spec directly.
   * Nothing is lost by not re-ingesting a document: `decrypt()` builds the instance
   * through the version class's own `deserialize`, which is the same validation the
   * round trip through a wire form was getting downstream.
   *
   * Event metadata (hash, height) is not carried across for the same reason: it belongs
   * to the message, not to the spec, and there is no document left to hang it on. No
   * consumer reads it off an app spec.
   *
   * @param {Object} appSpec a sealed wire document
   * @returns {Promise<Object|null>} a readable spec, or null if it could not be read
   */
  async #decryptAppSpec(appSpec) {
    const { hash } = appSpec;

    const cached = hash ? this.#cache.get(hash) : null;
    if (cached) return cached;

    try {
      await this.#ensureProviders();

      // deserialize -> EncryptedSpec -> decrypt(provider) -> DecryptedCanonicalSpec:
      // the version-blind decrypt lifecycle.
      const sealed = await specLibs.deserialize(appSpec);
      const provider = await sealed.createProvider();
      const decrypted = await sealed.decrypt(provider);

      // random TTL between 24-48h to avoid all entries expiring at the same time (they
      // are added nearly simultaneously via Promise.all). Skip caching a spec with no
      // hash — an undefined key would collide across specs.
      if (hash) {
        const ttl = 86_400_000 + Math.floor(Math.random() * 86_400_000);
        this.#cache.set(hash, decrypted, { ttl });
      }
      undecryptable.report(appSpec.name, false, () => `Unable to decrypt ${appSpec.name}`);
      return decrypted;
    } catch (error) {
      undecryptable.report(appSpec.name, true, () => `Unable to decrypt ${appSpec.name}: ${error.message}`);
      return null;
    }
  }

  async loop(runner, dataStore) {
    const store = dataStore;

    const { name } = store;
    let ms;
    try {
      ms = await runner();
      failingLoops.report(name, false, () => `${name} loop error`);
    } catch (error) {
      // A failed poll must reschedule, not kill the loop — and must never surface
      // as an unhandled rejection that exits the process.
      ms = store.defaultFetchMs || 30_000;
      failingLoops.report(name, true, () => `${name} loop error, retrying every ${ms}ms: ${error.message}`);
    }

    if (this.#aborted) return;

    store.timeout = setTimeout(() => this.loop(runner, store), ms);
  }

  startAppSpecLoop() {
    const { globalAppSpecs } = this.endpoints;

    const runner = this.appSpecRunner.bind(this);

    setImmediate(() => this.loop(runner, globalAppSpecs));
  }

  startAppsLocationsLoop() {
    const { appsLocations } = this.endpoints;

    const runner = this.appsLocationsRunner.bind(this);

    setImmediate(() => this.loop(runner, appsLocations));
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

    log.info(JSON.stringify(logger));

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

  async processAppsLocations(locations) {
    const locationsMap = new Map();

    locations.forEach((location) => {
      const { name } = location;
      if (!locationsMap.has(name)) locationsMap.set(name, []);

      const appLocations = locationsMap.get(name);
      appLocations.push(location);
    });

    this.emit('appsLocationsUpdated', locationsMap);
  }

  async processAppSpecs(specs) {
    const activeStandbyAppsMap = new Map();
    const activeActiveAppsMap = new Map();
    const appFqdns = [];
    const enterpriseApps = [];

    // Deserialize each spec through flux-spec and classify it by its resolved
    // shape — active-standby (a component runs the active-standby sync mode) vs
    // active-active — for every version alike. Still-sealed specs are set aside for
    // decryption. A spec this node can't read is logged and skipped, never
    // aborting the rest of the batch.
    //
    // Takes a wire document on the first pass and an already-readable spec on the
    // second (decryption yields the object, not a document); `deserialize` passes a
    // readable one straight through, so both passes run the same code. What the maps
    // carry is therefore whichever form the app arrived in, and every consumer of them
    // resolves through `specLibs` rather than reading raw fields.
    const classify = async (spec) => {
      if (!spec) return; // a decrypt that gave up returns null
      try {
        const instance = await specLibs.deserialize(spec);
        if (instance.sealed) {
          enterpriseApps.push(spec);
          return;
        }
        const deployment = await specLibs.resolveDeployment(instance, null);
        // Asked of the deployment, not folded here: which sync modes count, and
        // how each version spells them, is the spec library's to know.
        const isActiveStandby = deployment.hasActiveStandbySyncthing();
        (isActiveStandby ? activeStandbyAppsMap : activeActiveAppsMap).set(spec.name, spec);
        // Custom-domain FQDNs feed the cross-app ownership check, sourced from the
        // resolved loadBalancing so v9 is covered like every other version.
        appFqdns.push(FdmDataFetcher.#buildFqdnMap(deployment, spec.name));
        unresolvableSpecs.report(spec.name, false, () => `skipping spec ${spec.name}`);
      } catch (error) {
        unresolvableSpecs.report(spec && spec.name, true, () => `skipping spec ${spec && spec.name}: ${error.message}`);
      }
    };

    // Sequential so map insertion order stays deterministic — it feeds the order
    // apps are rendered into the config.
    const classifyAll = async (list) => {
      // eslint-disable-next-line no-restricted-syntax
      for (const spec of list) {
        // eslint-disable-next-line no-await-in-loop
        await classify(spec);
      }
    };

    const counts = () => JSON.stringify({
      activeStandby: activeStandbyAppsMap.size,
      activeActive: activeActiveAppsMap.size,
      enterprise: enterpriseApps.length,
    });

    await classifyAll(specs);
    log.info(`app specs classified (pre-decrypt): ${counts()}`);

    const decryptTasks = enterpriseApps.map(
      (spec) => () => this.#decryptAppSpec(spec),
    );
    const decryptResults = await runWithConcurrency(decryptTasks, 5);
    const decryptedSpecs = decryptResults
      .filter((r) => r.status === 'fulfilled')
      .map((r) => r.value);

    await classifyAll(decryptedSpecs);
    log.info(`app specs classified (post-decrypt): ${counts()}`);

    // Each app's identity is a field of its entry in the list, beside the spec; a
    // decrypted spec does not carry it, so it is passed on by name.
    const identities = new Map(specs.filter((spec) => spec && spec.identity).map((spec) => [spec.name, spec.identity]));

    this.emit('appSpecsUpdated', {
      activeStandbyApps: activeStandbyAppsMap,
      activeActiveApps: activeActiveAppsMap,
      appFqdns,
      identities,
    });
  }

  /**
   * Every current app spec in a readable form: cleartext ones as the wire documents
   * they arrived as, sealed ones as the spec objects decryption produced. Mixed by
   * design — a caller resolves through `specLibs`, which takes either.
   * @returns {Promise<Array<Object>>}
   */
  async getDecryptedSpecs() {
    const getRes = await this.doAppSpecsHttpGet();
    if (!getRes || !getRes.payload) return [];

    const { payload } = getRes;

    const specs = payload.filter(Boolean);
    // Version-blind sealed detection: a v9 encrypted spec has no `enterprise` field, so
    // the old `version >= 8 && enterprise` gate mis-classified it as cleartext and never
    // decrypted it.
    const sealedFlags = await Promise.all(specs.map((spec) => specLibs.isSealed(spec)));
    const allSpecs = [];
    const sealedApps = [];
    specs.forEach((spec, i) => (sealedFlags[i] ? sealedApps : allSpecs).push(spec));

    if (sealedApps.length) {
      const decryptTasks = sealedApps.map((spec) => () => this.#decryptAppSpec(spec));
      const results = await runWithConcurrency(decryptTasks, 5);
      results.forEach((result) => {
        if (result.status === 'fulfilled' && result.value) allSpecs.push(result.value);
      });
    }

    return allSpecs;
  }

  async getAndProcessPermMessages() {
    const { permMessages } = this.endpoints;

    const getRes = await this.doPermMessagesHttpGet();
    if (!getRes || !getRes.payload) return permMessages.defaultFetchMs;

    const {
      payload, etag, maxAgeMs, backend,
    } = getRes;

    permMessages.etag = etag;
    permMessages.maxAgeMs = maxAgeMs;

    const fetchTime = FdmDataFetcher.now;

    const hasher = crypto.createHash('sha1');
    const specSha = hasher.update(JSON.stringify(payload)).digest('hex');

    if (specSha !== permMessages.sha) {
      console.log('permMessages have a different SHA... processing');
      permMessages.sha = specSha;
      await this.processPermMessages(payload);
    }

    const elapsedMs = Number(FdmDataFetcher.now - fetchTime) / 1_000_000;
    // add a one second overlay here. This stops retries when the max-age is
    // at 0.
    const sleepTimeMs = Math.max(1_000, maxAgeMs - elapsedMs + 1_000);

    const logger = {
      name: 'permMessages',
      verb: 'get',
      backend,
      etag,
      payloadSize: payload ? payload.length : 0,
      sleepTimeMs,
      timestamp: FdmDataFetcher.timestamp(),
    };
    log.info(JSON.stringify(logger));

    return sleepTimeMs;
  }

  async getAndProcessAppSpecs() {
    const { globalAppSpecs } = this.endpoints;

    const getRes = await this.doAppSpecsHttpGet();
    // A 200 does not guarantee a payload: an empty body, or a body whose own status is
    // not `success`, parses to a response object carrying `payload: null`. Checking only
    // the response object let that null through to be processed, where iterating it threw
    // — which on a build without the loop's catch takes the process down. The dev
    // director restarted 1093 times on exactly this. Nothing to process is not an error;
    // it means wait and ask again.
    if (!getRes || !getRes.payload) return globalAppSpecs.defaultFetchMs;

    const {
      payload, etag, maxAgeMs, backend,
    } = getRes;

    if (!this.#admitSpecList(payload, backend, etag)) return globalAppSpecs.defaultFetchMs;

    globalAppSpecs.etag = etag;
    globalAppSpecs.maxAgeMs = maxAgeMs;

    const fetchTime = FdmDataFetcher.now;

    const hasher = crypto.createHash('sha1');
    const specSha = hasher.update(JSON.stringify(payload)).digest('hex');

    if (specSha !== globalAppSpecs.sha) {
      console.log('globalAppSpecs have a different SHA... processing');
      globalAppSpecs.sha = specSha;
      await this.processAppSpecs(payload);
    }

    const elapsedMs = Number(FdmDataFetcher.now - fetchTime) / 1_000_000;
    // add a one second overlay here. This stops retries when the max-age is
    // at 0.
    const sleepTimeMs = Math.max(1_000, maxAgeMs - elapsedMs + 1_000);

    const logger = {
      name: 'globalAppSpecs',
      verb: 'get',
      backend,
      etag,
      payloadSize: payload ? payload.length : 0,
      sleepTimeMs,
      timestamp: FdmDataFetcher.timestamp(),
    };
    log.info(JSON.stringify(logger));

    return sleepTimeMs;
  }

  async getAndProcessAppsLocations() {
    const { appsLocations } = this.endpoints;

    // this call is 2.1Mb without compression and 0.37Mb compressed (axios uses
    // compression)
    const getRes = await this.doAppsLocationsHttpGet();
    if (!getRes || !getRes.payload) return appsLocations.defaultFetchMs;

    const {
      payload, etag, maxAgeMs, backend,
    } = getRes;

    appsLocations.etag = etag;
    appsLocations.maxAgeMs = maxAgeMs;

    await this.processAppsLocations(payload);

    // Hardsetting this to 10 seconds now (we try a different node on each call)
    const sleepTimeMs = 10_000;

    const logger = {
      name: 'appsLocations',
      verb: 'get',
      backend,
      etag,
      payloadSize: payload ? payload.length : 0,
      sleepTimeMs,
      timestamp: FdmDataFetcher.timestamp(),
    };
    log.info(JSON.stringify(logger));

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
        fetchFailures.report('HEAD perm messages:request', true, () => `HEAD perm messages: unable to do HTTP HEAD: ${err.message}`);
        return null;
      });
    if (response) fetchFailures.report('HEAD perm messages:request', false, () => 'HEAD perm messages: unable to do HTTP HEAD');

    const parsed = FdmDataFetcher.#parseAxiosResponse(response, {
      head: true,
      endpoint: 'HEAD perm messages',
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
        fetchFailures.report('HEAD app specs:request', true, () => `HEAD app specs: unable to do HTTP HEAD: ${err.message}`);
        return null;
      });
    if (response) fetchFailures.report('HEAD app specs:request', false, () => 'HEAD app specs: unable to do HTTP HEAD');

    const parsed = FdmDataFetcher.#parseAxiosResponse(response, {
      head: true,
      endpoint: 'HEAD app specs',
    });

    return parsed;
  }

  /**
   *
   * @returns {Promise<>}
   */
  async doAppsLocationsHttpHead() {
    const response = await this.#fluxApi
      .head(this.endpoints.appsLocations.url)
      .catch((err) => {
        fetchFailures.report('HEAD app locations:request', true, () => `HEAD app locations: unable to do HTTP HEAD: ${err.message}`);
        return null;
      });
    if (response) fetchFailures.report('HEAD app locations:request', false, () => 'HEAD app locations: unable to do HTTP HEAD');

    const parsed = FdmDataFetcher.#parseAxiosResponse(response, {
      head: true,
      endpoint: 'HEAD app locations',
    });

    return parsed;
  }

  async doAppSpecsHttpGet() {
    const response = await this.#fluxApi
      .get(this.endpoints.globalAppSpecs.url)
      .catch((err) => {
        fetchFailures.report('GET app specs:request', true, () => `GET app specs: unable to do HTTP GET: ${err.message}`);
        return null;
      });
    if (response) fetchFailures.report('GET app specs:request', false, () => 'GET app specs: unable to do HTTP GET');

    const parsed = FdmDataFetcher.#parseAxiosResponse(response, {
      endpoint: 'GET app specs',
    });

    return parsed;
  }

  async doAppsLocationsHttpGet() {
    const response = await this.#fluxApi
      .get(this.endpoints.appsLocations.url)
      .catch((err) => {
        fetchFailures.report('GET app locations:request', true, () => `GET app locations: unable to do HTTP GET: ${err.message}`);
        return null;
      });
    if (response) fetchFailures.report('GET app locations:request', false, () => 'GET app locations: unable to do HTTP GET');

    const parsed = FdmDataFetcher.#parseAxiosResponse(response, {
      endpoint: 'GET app locations',
    });

    return parsed;
  }

  async doPermMessagesHttpGet() {
    // we get the compressed output. 56Mb vs 11Mb
    // this is still ridiculous though - we don't need to fetch the entire
    // message list every time
    const { permMessages: { options } } = this.endpoints;

    const response = await this.#fluxApi
      .get(this.endpoints.permMessages.url, options)
      .catch((err) => {
        fetchFailures.report('GET perm messages:request', true, () => `GET perm messages: unable to do HTTP GET: ${err.message}`);
        return null;
      });
    if (response) fetchFailures.report('GET perm messages:request', false, () => 'GET perm messages: unable to do HTTP GET');

    const parsed = FdmDataFetcher.#parseAxiosResponse(response, {
      endpoint: 'GET perm messages',
    });

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
   * Checks the latest apps locations via ETAG, if different, runs a GET.
   * @returns {Promise<number>} Ms until next loop time
   */
  async appsLocationsRunner() {
    // don't do the head request here anymore, as the endpoint is always different.
    // this is now hardcoded to run every 10 seconds

    const getMaxAgeMs = await this.getAndProcessAppsLocations();

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
  const dataFetcher = new FdmDataFetcher({
    keyPath: '/etc/ssl/private/fdm-arcane.key',
    certPath: '/etc/ssl/certs/fdm-arcane.pem',
    caPath: '/etc/ssl/certs/fdm-arcane-ca.pem',
    fluxApiBaseUrl: 'https://api.runonflux.io/',
    cryptoService: config.cryptoService,
  });

  dataFetcher.startAppSpecLoop();
  dataFetcher.startPermMessagesLoop();
  dataFetcher.startAppsLocationsLoop();
  dataFetcher.on('appSpecsUpdated', (specs) => console.log(
    'Received appSpecsUpdated event with spec sizes:',
    specs.activeStandbyApps.size,
    specs.activeActiveApps.size,
  ));
  dataFetcher.on('permMessagesUpdated', (messages) => console.log(
    'Received permMessagesUpdated event with spec size:',
    messages.length,
  ));
  dataFetcher.on('appsLocationsUpdated', (locations) => console.log(
    'Received appsLocationsUpdated event with location size:',
    locations.size,
  ));
}

module.exports = { FdmDataFetcher };

if (require.main === module) {
  main();
}

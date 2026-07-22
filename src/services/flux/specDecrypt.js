// FDM reads sealed (encrypted) app specs through flux-spec's decrypt lifecycle:
// EncryptedSpec.decrypt(provider) -> DecryptedCanonicalSpec. flux-spec is transport-
// agnostic — it never knows how the bytes are decrypted — so FDM supplies that here.
// A single provider adapter carries the app identity and delegates to a version-
// specific open function; the two are registered on the flux-spec EncryptedSpec classes
// so decrypt() dispatches by version with no branching at the call site.
const crypto = require('node:crypto');

const log = require('../../lib/log');
const { load } = require('./specLibs');

// v8 sealed blob layout: an RSA-wrapped AES key, then AES-256-GCM (nonce, ciphertext,
// tag). The key wrap is opened by the backend; the GCM open is local.
const RSA_WRAPPED_KEY_BYTES = 256;
const GCM_NONCE_BYTES = 12;
const GCM_TAG_BYTES = 16;

// Carried on the v8 key-unwrap request; the backend keys its response on it.
const UNWRAP_BLOCK_HEIGHT = 9999999;

// The unwrap call is retried across transient backend unavailability — the director
// VIP can briefly drop a node during failover (health-check cycle ~30s).
const UNWRAP_ATTEMPTS = 4;
const UNWRAP_RETRY_MS = 16_000;

function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/**
 * Unwrap the v8 AES session key via the backend, retried across transient failover.
 * @returns {Promise<Buffer>} the raw AES key bytes
 */
async function unwrapV8Key(http, endpoint, appName, owner, wrappedKey) {
  const payload = {
    fluxID: owner,
    appName,
    message: wrappedKey.toString('base64'),
    blockHeight: UNWRAP_BLOCK_HEIGHT,
  };
  for (let attempt = 0; attempt < UNWRAP_ATTEMPTS; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop
    const response = await http.post(endpoint, payload).catch((err) => {
      log.warn(`Unable to reach decrypt service for ${appName}: ${err.message}`);
      return null;
    });
    if (response && response.status === 200) {
      const { status, message } = response.data;
      if (status !== 'ok') {
        throw new Error(`decrypt service rejected key unwrap for ${appName}`);
      }
      if (message) return Buffer.from(message, 'base64');
    }
    if (attempt < UNWRAP_ATTEMPTS - 1) {
      // eslint-disable-next-line no-await-in-loop
      await sleep(UNWRAP_RETRY_MS);
    }
  }
  throw new Error(`could not unwrap key for ${appName} after ${UNWRAP_ATTEMPTS} attempts`);
}

/**
 * Build the version-specific decrypt providers over `http` (an mTLS axios instance) and
 * the configured endpoint paths, and register them on the flux-spec EncryptedSpec
 * classes. The CryptoProvider base is async-loaded, so the provider is defined here
 * rather than at module top level.
 *
 * @param {{
 *   http: import('axios').AxiosInstance,
 *   endpoints: { rsaDecrypt: string, gcmDecrypt: string },
 * }} deps
 * @returns {Promise<void>}
 */
async function registerSpecDecryptProviders({ http, endpoints }) {
  const { CryptoProvider, EncryptedSpecV8, EncryptedSpecV9 } = await load();

  // v8: unwrap the AES key via the backend, then open AES-256-GCM locally.
  const openV8 = async (encrypted, _aad, appName, owner) => {
    const blob = Buffer.from(encrypted.ciphertext, 'base64');
    if (blob.length < RSA_WRAPPED_KEY_BYTES + GCM_NONCE_BYTES + GCM_TAG_BYTES) {
      throw new Error(`sealed v8 blob shorter than minimum layout for ${appName}`);
    }
    const wrappedKey = blob.subarray(0, RSA_WRAPPED_KEY_BYTES);
    const rest = blob.subarray(RSA_WRAPPED_KEY_BYTES);
    const nonce = rest.subarray(0, GCM_NONCE_BYTES);
    const body = rest.subarray(GCM_NONCE_BYTES, -GCM_TAG_BYTES);
    const tag = rest.subarray(-GCM_TAG_BYTES);

    const aesKey = await unwrapV8Key(http, endpoints.rsaDecrypt, appName, owner, wrappedKey);
    const decipher = crypto.createDecipheriv('aes-256-gcm', aesKey, nonce);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]);
  };

  // v9: forward the structured GCM envelope + AAD; the backend performs the whole open
  // and returns the base64 plaintext (key derivation is entirely backend-side).
  const openV9 = async (encrypted, aad, appName, owner) => {
    const { ciphertext, nonce, tag } = encrypted;
    const payload = {
      appName, fluxID: owner, ciphertext, nonce, tag,
    };
    if (aad) payload.aad = aad.toString('base64');

    const response = await http.post(endpoints.gcmDecrypt, payload);
    if (response.status !== 200) {
      throw new Error(`decrypt service HTTP ${response.status} for ${appName}`);
    }
    const { status, message } = response.data;
    if (status !== 'ok') {
      throw new Error(`decrypt service rejected ${appName}`);
    }
    return Buffer.from(message, 'base64');
  };

  // One adapter; the version-specific open is injected. flux-spec calls
  // decrypt(encrypted, aad) and only requires an instanceof CryptoProvider.
  class SpecDecryptProvider extends CryptoProvider {
    #open;

    #appName;

    #owner;

    constructor(open, appName, owner) {
      super();
      this.#open = open;
      this.#appName = appName;
      this.#owner = owner;
    }

    decrypt(encrypted, aad) {
      return this.#open(encrypted, aad, this.#appName, this.#owner);
    }
  }

  EncryptedSpecV8.registerProvider((name, owner) => new SpecDecryptProvider(openV8, name, owner));
  EncryptedSpecV9.registerProvider((name, owner) => new SpecDecryptProvider(openV9, name, owner));
}

module.exports = { registerSpecDecryptProviders };

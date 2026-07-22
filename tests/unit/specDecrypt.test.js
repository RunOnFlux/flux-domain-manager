// The decrypt providers plug FDM's HTTP transport into flux-spec's decrypt lifecycle
// (EncryptedSpec.decrypt(provider) -> DecryptedCanonicalSpec). v8 does a real local
// AES-256-GCM open after the backend unwraps the key; v9 forwards the GCM envelope to
// the backend. Here the transport is a stub responder, so the v8 crypto is exercised
// for real (only the key unwrap is stubbed) and the version-blind wire emission is
// checked end to end: v8 -> compose, v9 -> components, no sealed marker.
const chai = require('chai');
const crypto = require('node:crypto');
const { registerSpecDecryptProviders } = require('../../src/services/flux/specDecrypt');
const specLibs = require('../../src/services/flux/specLibs');

const { expect } = chai;

const ENDPOINTS = { rsaDecrypt: 'decryptMessageRSA', gcmDecrypt: 'v2/decrypt' };

// A valid, minimal cleartext v8 component (shape from a real on-chain spec).
const V8_COMPONENT = {
  name: 'app',
  description: 'app',
  repotag: 'siomiz/softethervpn:5.02.5185',
  ports: [31443],
  domains: [''],
  environmentParameters: [],
  commands: [],
  containerPorts: [443],
  containerData: '/tmp',
  cpu: 0.1,
  ram: 100,
  hdd: 1,
  repoauth: '',
};

const v8Wire = (enterprise, extra = {}) => ({
  version: 8,
  name: 'entv8',
  description: 'x',
  owner: '19z6SjrVrWqBTLiCXWLRjcu9ydnzWNz3UD',
  compose: [],
  instances: 3,
  contacts: [],
  geolocation: [],
  expire: 88000,
  nodes: [],
  staticip: false,
  enterprise,
  ...extra,
});

// Seal {compose, contacts} the way the v8 enterprise path does: an RSA-wrapped AES key
// (stubbed as 256 opaque bytes) followed by AES-256-GCM(nonce | ciphertext | tag).
const sealV8 = (payloadObj, aesKey) => {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', aesKey, nonce);
  const ct = Buffer.concat([cipher.update(JSON.stringify(payloadObj), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const wrappedKey = crypto.randomBytes(256); // opaque to us; the backend unwraps it
  return Buffer.concat([wrappedKey, nonce, ct, tag]).toString('base64');
};

describe('specDecrypt providers — decrypt lifecycle over a stub transport', () => {
  // A stable http object whose behaviour each test swaps via `responder`, so a single
  // registration serves every case (registration is a global side effect).
  let responder;
  const http = { post: (url, payload) => responder(url, payload) };

  before(async () => {
    await registerSpecDecryptProviders({ http, endpoints: ENDPOINTS });
  });

  beforeEach(() => {
    responder = () => { throw new Error('no responder set'); };
  });

  it('v8: unwraps the key, opens AES-GCM locally, and re-emits a cleartext compose wire', async () => {
    const aesKey = crypto.randomBytes(32);
    const enterprise = sealV8({ compose: [V8_COMPONENT], contacts: [] }, aesKey);

    // The backend returns the (base64) AES key for the wrapped-key blob.
    responder = async (url) => {
      expect(url).to.equal(ENDPOINTS.rsaDecrypt);
      return { status: 200, data: { status: 'ok', message: aesKey.toString('base64') } };
    };

    const sealed = await specLibs.deserialize(v8Wire(enterprise, { hash: 'deadbeef', height: 2743233 }));
    const provider = await sealed.createProvider();
    const decrypted = await sealed.decrypt(provider);
    const out = decrypted.spec.serialize();

    expect(out.compose).to.have.lengthOf(1);
    expect(out.compose[0].repotag).to.equal(V8_COMPONENT.repotag);
    expect(out.compose[0].ports).to.deep.equal(V8_COMPONENT.ports);
    expect(out.compose[0].containerPorts).to.deep.equal(V8_COMPONENT.containerPorts);
    expect(out.compose[0].containerData).to.equal(V8_COMPONENT.containerData);
    // serialize() drops the sealed marker, so the result re-ingests as cleartext.
    // (hash/height are re-attached one layer up, in #decryptAppSpec.)
    expect(await specLibs.isSealed(out)).to.equal(false);
  });

  it('v8: throws when the backend rejects the unwrap (so the caller fails closed)', async () => {
    const enterprise = sealV8({ compose: [V8_COMPONENT], contacts: [] }, crypto.randomBytes(32));
    responder = async () => ({ status: 200, data: { status: 'error' } });

    const sealed = await specLibs.deserialize(v8Wire(enterprise));
    const provider = await sealed.createProvider();
    let threw = false;
    try {
      await sealed.decrypt(provider);
    } catch (e) {
      threw = true;
    }
    expect(threw).to.equal(true);
  });

  it('v9: forwards the GCM envelope + AAD and re-emits a cleartext components wire', async () => {
    const { FluxAppSpecV9, EncryptedSpecV9, CryptoProvider } = await specLibs.load();

    const cleartext = FluxAppSpecV9.fromSubmission({
      version: 9,
      name: 'entv9',
      description: 'x',
      owner: '16dNCFf7nR3nx5iwn2RQMBw6KcJXkE3JC1',
      ttl: 2592000,
      contacts: { email: ['a@b.com'] },
      instances: 1,
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
          loadBalancing: { http: { provider: 'haproxy', mode: 'http' } },
        },
      },
    });

    // Seal via a stub encrypt provider that captures the plaintext (what the real
    // backend would return on decrypt) and hands back a fixed envelope.
    class StubEncrypt extends CryptoProvider {
      async encrypt(plaintext) {
        this.captured = plaintext;
        return {
          algorithm: 'AES-256-GCM', ciphertext: 'Y3Q=', nonce: 'bm9uY2U=', tag: 'dGFn',
        };
      }
    }
    const encryptStub = new StubEncrypt();
    const encryptedSpec = await EncryptedSpecV9.fromSpec(cleartext, encryptStub);

    let seenPayload = null;
    responder = async (url, payload) => {
      seenPayload = payload;
      return { status: 200, data: { status: 'ok', message: encryptStub.captured.toString('base64') } };
    };

    const provider = await encryptedSpec.createProvider();
    const decrypted = await encryptedSpec.decrypt(provider);
    const out = decrypted.spec.serialize();

    // Version-correct shape: v9 emits components, not compose.
    expect(out.components).to.be.an('object');
    expect(out.components.web.image).to.equal('nginx:latest');
    expect(out.compose).to.equal(undefined);
    expect(await specLibs.isSealed(out)).to.equal(false);

    // Transport carried the whole envelope + base64 AAD to the configured endpoint.
    expect(seenPayload).to.include.keys('appName', 'fluxID', 'ciphertext', 'nonce', 'tag', 'aad');
    expect(seenPayload.ciphertext).to.equal('Y3Q=');
    expect(seenPayload.appName).to.equal('entv9');
  });
});

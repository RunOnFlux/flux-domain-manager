// FDM's single touch-point for flux-spec. flux-spec is ESM; @runonflux/flux-spec-cjs
// bridges it for CommonJS so only these helpers are async and the rest of FDM stays
// synchronous. FDM's specs arrive already-registered from the FluxOS API / DB, so we
// `deserialize` rather than `fromSubmission` (which additionally rejects fields no
// longer accepted on new user submissions — wrong for data that was already valid).
const { load } = require('@runonflux/flux-spec-cjs');

// FDM routes; it never runs containers, so it reads only loadBalancing + host ports
// off the resolved DeploymentSpec, never mounts. The appsFolder — used solely for
// mount path resolution — is therefore a placeholder.
const APPS_FOLDER = '/var/lib/fdm/placeholder';

/**
 * Deserialize a wire-form spec document (any version v1-v9, cleartext or encrypted)
 * into its flux-spec instance. Callers branch on `instanceof EncryptedSpecBase`.
 * @param {Object} doc
 * @returns {Promise<Object>}
 */
async function deserialize(doc) {
  const { deserializeSpec } = await load();
  return deserializeSpec(doc);
}

/**
 * Whether a wire-form spec document is sealed — encrypted and unreadable until
 * decrypted — for any version (v8 enterprise blob or v9 encrypted envelope). Lets
 * callers set sealed specs aside for decryption without a version-specific field
 * check. Uses the classes' own wire predicates, so no full deserialize is needed.
 * @param {Object} doc
 * @returns {Promise<boolean>}
 */
async function isSealed(doc) {
  const { EncryptedSpecV8, EncryptedSpecV9 } = await load();
  return Boolean(EncryptedSpecV8.matchesWire(doc) || EncryptedSpecV9.matchesWire(doc));
}

/**
 * Resolve a readable spec into its per-node, per-replica runtime projection:
 * version-normalized to one shape, with ports x loadBalancing merged. `replica` is
 * null for the declared/loose view or a named replica for a co-located one
 * (effectiveForReplica is applied internally).
 * @param {Object} spec a readable FluxAppSpec (or DecryptedCanonicalSpec)
 * @param {string|null} [replica]
 * @returns {Promise<Object>} DeploymentSpec
 */
async function resolveDeployment(spec, replica = null) {
  const { DeploymentSpec } = await load();
  return DeploymentSpec.fromSpec(spec, APPS_FOLDER, { replica });
}

module.exports = {
  load, deserialize, isSealed, resolveDeployment, APPS_FOLDER,
};

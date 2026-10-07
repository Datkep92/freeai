/**
 * Import / export (plan 31).
 *
 * Export omits secrets by default. Import merges and dedupes rather than
 * overwriting, so importing an old file cannot silently drop a key the user
 * added since.
 *
 * Which fields are secret is read from the schema rather than listed here. A
 * hard-coded store name is a place a new secret field can be added without the
 * export noticing, and the failure is a credential in a file the user shares.
 */

import { SCHEMA_VERSION, stripSecrets } from './db/schema.js';

/**
 * The stores an export carries.
 *
 * Deliberately not every store: `settings`, `unresolved` and `deletedKeys` are
 * about this one device. Moving them to another machine would carry over a
 * parked secret and a list of keys the user chose to delete there.
 */
const EXPORT_STORES = ['providers', 'models', 'keys', 'mappings'];

/**
 * @param includeSecrets false by default. Passing true is an explicit,
 * deliberate act by the user, which is why it has to be spelled out.
 */
export async function exportRegistry(storage, { includeSecrets = false } = {}) {
  const out = {
    version: 2,
    // Which schema produced the file, so an import from a newer build can say
    // what it does not understand instead of quietly dropping it.
    schemaVersion: SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    includesSecrets: includeSecrets,
  };
  for (const store of EXPORT_STORES) {
    const rows = await storage.list(store);
    out[store] = includeSecrets ? rows : rows.map((row) => stripSecrets(store, row));
  }
  return out;
}

/**
 * Import merges and dedupes (plan 31).
 *
 * Dedupe has to be by meaning, not by id. The same provider pasted twice gets
 * two different ids, so an id-only check would happily import a second copy
 * of a URL that already exists - and then every key and model in the file
 * would point at the copy that is not the one the user sees in the UI.
 *
 * So providers are matched on their normalised URL, models on provider + id,
 * keys on provider + fingerprint, and only then are the id references
 * rewritten onto whatever the local rows actually are.
 */
export async function importRegistry(storage, payload) {
  if (!payload || typeof payload !== 'object') return { ok: false, reason: 'BAD_PAYLOAD' };

  const summary = { providers: 0, models: 0, keys: 0, mappings: 0, skipped: 0, merged: 0 };

  // providerId in the file -> the id this machine actually uses
  const providerIdMap = new Map();
  const existingProviders = await storage.list('providers');
  const byUrl = new Map(existingProviders.map((p) => [normalize(p.baseURL), p]));
  // Collected and written in one batch at the end. One `put` per row means one
  // transaction per row on IndexedDB, so importing a 60-model registry opened
  // hundreds of transactions for what is a single operation to the user.
  const newProviders = [];

  for (const row of payload.providers ?? []) {
    if (!row?.id || !row?.baseURL) {
      summary.skipped += 1;
      continue;
    }
    const url = normalize(row.baseURL);
    const existing = byUrl.get(url);
    if (existing) {
      providerIdMap.set(row.id, existing.id);
      summary.merged += 1;
      continue;
    }
    // The URL is normalised on the way in, so the row satisfies the same unique
    // index every other provider does. A file written by an older build can
    // carry a trailing slash, and storing it raw would create a second URL row
    // that the app would then show as a different provider.
    const fixed = { ...row, baseURL: url };
    newProviders.push(fixed);
    byUrl.set(url, fixed);
    providerIdMap.set(row.id, row.id);
    summary.providers += 1;
  }
  if (newProviders.length) await storage.putMany('providers', newProviders);

  const remap = (providerId) => providerIdMap.get(providerId) ?? providerId;

  const existingModels = await storage.list('models');
  const modelKey = (m) => `${m.providerId}::${m.modelId}`;
  const modelsSeen = new Set(existingModels.map(modelKey));
  const newModels = [];

  for (const row of payload.models ?? []) {
    if (!row?.id || !row?.modelId || !row?.providerId) {
      summary.skipped += 1;
      continue;
    }
    const fixed = { ...row, providerId: remap(row.providerId) };
    const identity = modelKey(fixed);
    if (modelsSeen.has(identity)) {
      summary.merged += 1;
      continue;
    }
    newModels.push(fixed);
    modelsSeen.add(identity);
    summary.models += 1;
  }
  if (newModels.length) await storage.putMany('models', newModels);

  const existingKeys = await storage.list('keys');
  const keyIdentity = (k) => `${k.providerId}::${k.fingerprint}`;
  const keysSeen = new Set(existingKeys.filter((k) => k.fingerprint).map(keyIdentity));
  const newKeys = [];

  for (const row of payload.keys ?? []) {
    if (!row?.id || !row?.providerId || !row?.fingerprint) {
      summary.skipped += 1;
      continue;
    }
    const fixed = { ...row, providerId: remap(row.providerId) };
    const identity = keyIdentity(fixed);
    if (keysSeen.has(identity)) {
      summary.merged += 1;
      continue;
    }
    newKeys.push(fixed);
    keysSeen.add(identity);
    summary.keys += 1;
  }
  if (newKeys.length) await storage.putMany('keys', newKeys);

  const existingMappings = await storage.list('mappings');
  const mappingIdentity = (m) => `${m.providerId}::${m.modelId}::${m.keyId}`;
  const mappingsSeen = new Set(existingMappings.map(mappingIdentity));
  const keyIdMap = new Map(existingKeys.map((k) => [k.id, k.id]));
  const newMappings = [];

  for (const row of payload.mappings ?? []) {
    if (!row?.id || !row?.providerId || !row?.modelId || !row?.keyId) {
      summary.skipped += 1;
      continue;
    }
    const providerId = remap(row.providerId);
    // A mapping whose key landed on a different local row must follow it,
    // otherwise it would dangle and never be routable.
    const keyId = keyIdMap.get(row.keyId) ?? row.keyId;
    const fixed = { ...row, providerId, keyId };
    const identity = mappingIdentity(fixed);
    if (mappingsSeen.has(identity)) {
      summary.merged += 1;
      continue;
    }
    // The identity is what makes a mapping unique, so it is rebuilt from the
    // remapped ids. Carrying the file's own value over would leave a row whose
    // identity does not match its own columns - invisible to `by_identity`,
    // which is the index every lookup goes through.
    const identityRow = { ...fixed, identity: `${providerId}::${fixed.modelId}::${keyId}` };
    newMappings.push(identityRow);
    mappingsSeen.add(identity);
    summary.mappings += 1;
  }
  if (newMappings.length) await storage.putMany('mappings', newMappings);

  return { ok: true, ...summary };
}

function normalize(url) {
  return String(url ?? '').trim().replace(/\/+$/, '');
}

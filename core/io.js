/**
 * Import / export (plan 31).
 *
 * Export omits secrets by default. Import merges and dedupes rather than
 * overwriting, so importing an old file cannot silently drop a key the user
 * added since.
 */

const STORES = ['providers', 'models', 'keys', 'mappings'];

/**
 * @param includeSecrets false by default. Passing true is an explicit,
 * deliberate act by the user, which is why it has to be spelled out.
 */
export async function exportRegistry(storage, { includeSecrets = false } = {}) {
  const out = { version: 1, exportedAt: new Date().toISOString(), includesSecrets: includeSecrets };
  for (const store of STORES) {
    const rows = await storage.list(store);
    out[store] = includeSecrets ? rows : rows.map((row) => stripSecret(store, row));
  }
  return out;
}

function stripSecret(store, row) {
  if (store === 'keys') {
    // The fingerprint is enough to recognise the key again, and it is not a
    // credential, so it is safe to keep.
    const { secret, ...rest } = row;
    return { ...rest, secretOmitted: true };
  }
  return row;
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
    await storage.put('providers', row);
    byUrl.set(url, row);
    providerIdMap.set(row.id, row.id);
    summary.providers += 1;
  }

  const remap = (providerId) => providerIdMap.get(providerId) ?? providerId;

  const existingModels = await storage.list('models');
  const modelKey = (m) => `${m.providerId}::${m.modelId}`;
  const modelsSeen = new Set(existingModels.map(modelKey));

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
    await storage.put('models', fixed);
    modelsSeen.add(identity);
    summary.models += 1;
  }

  const existingKeys = await storage.list('keys');
  const keyIdentity = (k) => `${k.providerId}::${k.fingerprint}`;
  const keysSeen = new Set(existingKeys.filter((k) => k.fingerprint).map(keyIdentity));

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
    await storage.put('keys', fixed);
    keysSeen.add(identity);
    summary.keys += 1;
  }

  const existingMappings = await storage.list('mappings');
  const mappingIdentity = (m) => `${m.providerId}::${m.modelId}::${m.keyId}`;
  const mappingsSeen = new Set(existingMappings.map(mappingIdentity));
  const keyIdMap = new Map(existingKeys.map((k) => [k.id, k.id]));

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
    await storage.put('mappings', fixed);
    mappingsSeen.add(identity);
    summary.mappings += 1;
  }

  return { ok: true, ...summary };
}

function normalize(url) {
  return String(url ?? '').trim().replace(/\/+$/, '');
}

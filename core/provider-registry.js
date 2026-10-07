/**
 * Provider registry (plan 1, 2).
 *
 * Built-ins are seeded on first run. Custom providers can be added by hand,
 * and a custom provider whose discovery fails is still stored: the user may
 * know a model the /models endpoint does not list.
 */

import { BUILTIN_LIST } from './adapters/builtin.js';
import { createAdapter } from './adapters/builtin.js';
import { isoNow, makeId, normalizeBaseUrl } from './util.js';
import { CHILDREN_OF } from './db/schema.js';

export function normalizeWebsiteUrl(value) {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

export class ProviderRegistry {
  constructor(storage) {
    this.storage = storage;
  }

  /** Insert the built-in providers if they are not there yet. */
  async seedBuiltins() {
    let added = 0;
    for (const preset of BUILTIN_LIST) {
      const existing = await this.findByUrl(preset.baseURL);
      if (existing) {
        // Refresh only the descriptive fields. Status, breaker and scan time
        // belong to the live run and must survive a restart.
        const needsUpdate =
          existing.freeTier !== (preset.freeTier ?? 'none') ||
          (existing.note ?? '') !== (preset.note ?? '') ||
          (existing.verified ?? null) !== (preset.verified ?? null) ||
          (existing.websiteURL ?? '') !== (normalizeWebsiteUrl(preset.websiteURL) ?? '');
        if (needsUpdate) {
          await this.storage.put('providers', {
            ...existing,
            freeTier: preset.freeTier ?? 'none',
            note: preset.note ?? '',
            verified: preset.verified ?? null,
            websiteURL: normalizeWebsiteUrl(preset.websiteURL),
            updatedAt: isoNow(),
          });
        }
        continue;
      }
      await this.storage.put('providers', {
        id: preset.id,
        builtinId: preset.id,
        name: preset.name,
        type: preset.type,
        baseURL: normalizeBaseUrl(preset.baseURL),
        protocol: preset.protocol,
        modelsPath: preset.modelsPath,
        chatPath: preset.chatPath,
        // Kept on the row so the drawer can say what a URL is before it has
        // been scanned. A gateway with no free tier is worth showing anyway,
        // but only with that stated.
        freeTier: preset.freeTier ?? 'none',
        note: preset.note ?? '',
        // What the last live probe found. Null means "not probed yet", which is
        // different from a probe that said the entry is broken.
        verified: preset.verified ?? null,
        verifiedAt: preset.verified ? (preset.verifiedAt ?? null) : null,
        websiteURL: normalizeWebsiteUrl(preset.websiteURL),
        enabled: true,
        status: 'NEW',
        lastScanAt: null,
        metadata: {},
        createdAt: isoNow(),
        updatedAt: isoNow(),
      });
      added += 1;
    }
    return added;
  }

  async list() {
    return this.storage.list('providers');
  }

  async get(id) {
    return this.storage.get('providers', id);
  }

  /**
   * Duplicate check is on the normalised URL, not the name: the same gateway
   * pasted with and without a trailing slash is one provider, and two
   * different names pointing at one host would double-scan it.
   *
   * Asked of the index first, because this runs on every keystroke of the add
   * dialog. The scan behind it is the fallback for rows that were imported with
   * an unnormalised URL, which the unique index cannot match on.
   */
  async findByUrl(baseURL) {
    const target = normalizeBaseUrl(baseURL);
    const indexed = await this.storage.find('providers', { baseURL: target });
    if (indexed) return indexed;
    const all = await this.list();
    return all.find((p) => normalizeBaseUrl(p.baseURL) === target) ?? null;
  }

  async upsert({ name, baseURL, websiteURL, protocol = 'openai-compatible', modelsPath, chatPath, type = 'CUSTOM' }) {
    const normalized = normalizeBaseUrl(baseURL);
    if (!normalized) return { provider: null, created: false, reason: 'EMPTY_URL' };

    const duplicate = await this.findByUrl(normalized);
    if (duplicate) return { provider: duplicate, created: false, reason: 'DUPLICATE' };

    const provider = {
      id: makeId('prv'),
      builtinId: null,
      name: name?.trim() || hostOf(normalized),
      type,
      baseURL: normalized,
      protocol,
      modelsPath: modelsPath || '/models',
      chatPath: chatPath || '/chat/completions',
      websiteURL: normalizeWebsiteUrl(websiteURL),
      enabled: true,
      status: 'NEW',
      lastScanAt: null,
      metadata: {},
      createdAt: isoNow(),
      updatedAt: isoNow(),
    };
    await this.storage.put('providers', provider);
    return { provider, created: true };
  }

  async update(id, patch) {
    const provider = await this.get(id);
    if (!provider) return null;
    const updated = { ...provider, ...patch, updatedAt: isoNow() };
    await this.storage.put('providers', updated);
    return updated;
  }

  /**
   * Remove a provider and everything that belongs to it.
   *
   * Which stores those are is read from the schema's relations rather than
   * listed here, because this list used to be the third copy of it: forgetting
   * an entry left rows pointing at a URL that no longer exists, and every list in
   * the app is grouped by URL, so those rows became invisible - still on disk,
   * never shown, never cleaned.
   *
   * `metrics` is in that list too, which it was not before: a measurement of a
   * deleted URL kept its name in the speed ranking.
   */
  async remove(id) {
    const children = CHILDREN_OF.providers ?? [];
    for (const relation of children) {
      const rows = await this.storage.findMany(relation.store, { where: { [relation.field]: id } });
      if (!rows.length) continue;
      await this.storage.removeMany(relation.store, rows.map((row) => row.id));
    }
    await this.storage.remove('providers', id);
  }

  adapterFor(provider) {
    return createAdapter(provider);
  }

  /**
   * Aggregate health for the provider card.
   *
   * Counts rather than rows. The card only needs four numbers, and reading every
   * model of every URL to produce them was the most expensive thing the drawer
   * did on each render.
   */
  async summary(providerId) {
    const [models, freeModels, keys, mappings] = await Promise.all([
      this.storage.count('models', { providerId }),
      this.storage.count('models', { providerId, active: true }),
      this.storage.count('keys', { providerId }),
      this.storage.count('mappings', { providerId }),
    ]);
    return { models, freeModels, keys, mappings };
  }
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return String(url);
  }
}

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
          (existing.verified ?? null) !== (preset.verified ?? null);
        if (needsUpdate) {
          await this.storage.put('providers', {
            ...existing,
            freeTier: preset.freeTier ?? 'none',
            note: preset.note ?? '',
            verified: preset.verified ?? null,
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
   */
  async findByUrl(baseURL) {
    const target = normalizeBaseUrl(baseURL);
    const all = await this.list();
    return all.find((p) => normalizeBaseUrl(p.baseURL) === target) ?? null;
  }

  async upsert({ name, baseURL, protocol = 'openai-compatible', modelsPath, chatPath, type = 'CUSTOM' }) {
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

  /** Remove a provider and everything that belongs to it. */
  async remove(id) {
    const keys = await this.storage.list('keys');
    const models = await this.storage.list('models');
    const mappings = await this.storage.list('mappings');

    for (const row of [...keys, ...models, ...mappings]) {
      if (row.providerId === id) {
        const store = keys.includes(row) ? 'keys' : models.includes(row) ? 'models' : 'mappings';
        await this.storage.remove(store, row.id);
      }
    }
    await this.storage.remove('providers', id);
  }

  adapterFor(provider) {
    return createAdapter(provider);
  }

  /** Aggregate health for the provider card. */
  async summary(providerId) {
    const [models, keys, mappings] = await Promise.all([
      this.storage.list('models'),
      this.storage.list('keys'),
      this.storage.list('mappings'),
    ]);
    const mine = models.filter((m) => m.providerId === providerId);
    return {
      models: mine.length,
      freeModels: mine.filter((m) => m.active !== false).length,
      keys: keys.filter((k) => k.providerId === providerId).length,
      mappings: mappings.filter((m) => m.providerId === providerId).length,
    };
  }
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return String(url);
  }
}

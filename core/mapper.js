/**
 * Key x model mappings (plan 13, 14).
 *
 * The mapping is the unit everything else acts on: a verdict belongs to one
 * URL + model + key triple, never to the key alone. That is why a key that
 * works on model B must not be condemned because model A refused it.
 *
 * Secrets are not copied into mappings. They stay on the key row.
 */

import { STATUS } from './statuses.js';
import { computeCooldown, applyResult } from './health.js';
import { isoNow, makeId } from './util.js';

export function mappingIdentity(providerId, modelId, keyId) {
  return `${providerId}::${modelId}::${keyId}`;
}

export class Mapper {
  constructor(storage) {
    this.storage = storage;
  }

  async list(providerId = null) {
    const all = await this.storage.list('mappings');
    return providerId ? all.filter((m) => m.providerId === providerId) : all;
  }

  async get(id) {
    return this.storage.get('mappings', id);
  }

  async find(providerId, modelId, keyId) {
    const all = await this.list(providerId);
    return all.find((m) => m.modelId === modelId && m.keyId === keyId) ?? null;
  }

  /** Accepts a bare provider id or a filter object. */
  async filter(query = null) {
    const all = await this.list();
    if (!query) return all;
    if (typeof query === 'string') return all.filter((m) => m.providerId === query);
    return all.filter((m) => {
      if (query.providerId && m.providerId !== query.providerId) return false;
      if (query.keyId && m.keyId !== query.keyId) return false;
      if (query.modelId && m.modelId !== query.modelId) return false;
      if (query.status && m.status !== query.status) return false;
      return true;
    });
  }

  async upsert({ providerId, modelId, keyId }) {
    const existing = await this.find(providerId, modelId, keyId);
    if (existing) return { mapping: existing, created: false };

    const mapping = {
      id: makeId('map'),
      identity: mappingIdentity(providerId, modelId, keyId),
      providerId,
      modelId,
      keyId,
      status: STATUS.UNTESTED,
      verified: false,
      latencyMs: null,
      lastTestAt: null,
      lastSuccessAt: null,
      lastErrorClass: null,
      lastErrorMessage: null,
      cooldownUntil: null,
      failureCount: 0,
      score: 0,
      createdAt: isoNow(),
      updatedAt: isoNow(),
    };
    await this.storage.put('mappings', mapping);
    return { mapping, created: true };
  }

  async update(id, patch) {
    const mapping = await this.get(id);
    if (!mapping) return null;
    const updated = { ...mapping, ...patch, updatedAt: isoNow() };
    await this.storage.put('mappings', updated);
    return updated;
  }

  async remove(id) {
    await this.storage.remove('mappings', id);
  }

  /**
   * Record a probe result.
   *
   * Reuses the shared health transition so cooldown and failure counting can
   * never drift between the verifier and the router.
   */
  async record(mappingId, result) {
    const mapping = await this.get(mappingId);
    if (!mapping) return null;
    const next = applyResult(mapping, result);
    await this.storage.put('mappings', next);
    return next;
  }

  async clearCooldown(mappingId) {
    return this.update(mappingId, { cooldownUntil: null });
  }

  /** Drop mappings whose model or key no longer exists. */
  async pruneOrphans() {
    const [mappings, keys, models] = await Promise.all([
      this.storage.list('mappings'),
      this.storage.list('keys'),
      this.storage.list('models'),
    ]);
    const keyIds = new Set(keys.map((k) => k.id));
    const modelKeys = new Set(models.map((m) => `${m.providerId}::${m.modelId}`));

    let removed = 0;
    for (const mapping of mappings) {
      const alive =
        keyIds.has(mapping.keyId) && modelKeys.has(`${mapping.providerId}::${mapping.modelId}`);
      if (!alive) {
        await this.storage.remove('mappings', mapping.id);
        removed += 1;
      }
    }
    return removed;
  }
}

export { computeCooldown };

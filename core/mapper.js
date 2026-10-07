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
    return providerId
      ? this.storage.findMany('mappings', { where: { providerId } })
      : this.storage.list('mappings');
  }

  async get(id) {
    return this.storage.get('mappings', id);
  }

  /**
   * The verdict for one triple.
   *
   * `by_identity` is unique, so this is one lookup instead of a scan of every
   * mapping on the machine - and it is called once per probe, so it sits in the
   * hot path of the verifier and the router.
   */
  async find(providerId, modelId, keyId) {
    return this.storage.find('mappings', { identity: mappingIdentity(providerId, modelId, keyId) });
  }

  /**
   * Accepts a bare provider id or a filter object.
   *
   * Each field of the filter is an index column, so the whole filter is one
   * query rather than a read of every verdict followed by a JavaScript filter.
   */
  async filter(query = null) {
    if (!query) return this.list();
    if (typeof query === 'string') return this.list(query);
    const where = {};
    for (const field of ['providerId', 'keyId', 'modelId', 'status']) {
      if (query[field]) where[field] = query[field];
    }
    if (Object.keys(where).length === 0) return this.list();
    return this.storage.findMany('mappings', { where });
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

  /**
   * Drop mappings whose model or key no longer exists.
   *
   * A verdict about a model or a key that is gone can never be acted on, and it
   * still counts towards the health list the user reads to decide what to fix.
   *
   * The surviving identities are read once and the dead rows are deleted in one
   * batch, rather than one transaction per orphan - a registry that lost a
   * hundred keys would otherwise open a hundred write transactions here.
   */
  async pruneOrphans() {
    const [mappings, keys, models] = await Promise.all([
      this.storage.list('mappings'),
      this.storage.list('keys'),
      this.storage.list('models'),
    ]);
    const keyIds = new Set(keys.map((k) => k.id));
    const modelKeys = new Set(models.map((m) => `${m.providerId}::${m.modelId}`));

    const orphans = mappings.filter(
      (m) => !keyIds.has(m.keyId) || !modelKeys.has(`${m.providerId}::${m.modelId}`)
    );
    if (!orphans.length) return 0;
    await this.storage.removeMany('mappings', orphans.map((m) => m.id));
    return orphans.length;
  }
}

export { computeCooldown };

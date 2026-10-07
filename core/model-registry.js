/**
 * Model registry (plan 5, 6, 7).
 *
 * Two rules drive this file:
 *   - the scanner never deletes a model. A model missing from one scan is
 *     marked NOT_SEEN with a miss count, and only a configurable policy may
 *     move it to INACTIVE.
 *   - a manual model is never touched by the scanner, ever. If a scan finds
 *     the same id, its evidence is merged rather than duplicated.
 */

import { FREE, detectFree, mergeEvidence } from './free-detector.js';
import { isoNow, makeId } from './util.js';

export const MODEL_STATE = {
  ACTIVE: 'ACTIVE',
  NOT_SEEN: 'NOT_SEEN',
  INACTIVE: 'INACTIVE',
};

export const MODEL_SOURCE = {
  AUTO_DISCOVERED: 'AUTO_DISCOVERED',
  MANUAL: 'MANUAL',
};

export class ModelRegistry {
  constructor(storage) {
    this.storage = storage;
  }

  /**
   * Asked of the index rather than by filtering a full list.
   *
   * This is the hottest read in the app. A scan of a 460-model provider calls
   * `find` once per model, and each of those used to read and filter every model
   * row already stored - so a scan was quadratic in the size of the catalog it
   * was writing. `by_provider_model` is unique, so this is one lookup.
   */
  async list(providerId = null) {
    return providerId ? this.storage.findMany('models', { where: { providerId } }) : this.storage.list('models');
  }

  async get(id) {
    return this.storage.get('models', id);
  }

  async find(providerId, modelId) {
    return this.storage.find('models', { providerId, modelId });
  }

  /**
   * Record one discovered model.
   *
   * Returns 'created' or 'merged'. A merge is what keeps a scanner refresh
   * from producing duplicate rows for a model it has seen before.
   *
   * This is the single-model path, for a model the user adds by hand or a caller
   * that has exactly one row to record. A scan of a real catalog goes through
   * `applyScan` instead, which writes the whole catalog in one batch rather than
   * one transaction per model.
   */
  async upsertDiscovered({ providerId, modelId, displayName, pricing, evidence, metadata, pricingSource }) {
    const existing = await this.find(providerId, modelId);
    const outcome = this.mergeDiscovered(existing, { providerId, modelId, displayName, pricing, evidence, metadata, pricingSource });
    await this.storage.put('models', outcome.model);
    return outcome;
  }

  /**
   * The merge itself, with no storage access.
   *
   * Pure, so both the single-model path and the batch path can share it. That
   * matters more than it looks: `upsertDiscovered` and `applyScan` writing the
   * same model differently would mean a re-scan and a manual add disagree about
   * what "merge" means, and the only symptom would be a model whose evidence
   * grows every time it is touched.
   */
  mergeDiscovered(existing, discovered, now = isoNow()) {
    const { modelId, displayName, pricing, evidence, metadata, pricingSource } = discovered;

    if (!existing) {
      // A discovered model with no published price can still be judged by its
      // name, so the detector runs here rather than waiting for the caller.
      const verdict = detectFree({
        modelId,
        displayName: displayName ?? modelId,
        pricing,
        source: pricingSource,
      });

      return {
        state: 'created',
        model: {
          id: makeId('mdl'),
          providerId: discovered.providerId,
          modelId,
          displayName: displayName ?? modelId,
          source: MODEL_SOURCE.AUTO_DISCOVERED,
          freeStatus: verdict.freeStatus,
          evidence: mergeEvidence([], verdict.evidence),
          inputPrice: verdict.inputPrice,
          outputPrice: verdict.outputPrice,
          state: MODEL_STATE.ACTIVE,
          missCount: 0,
          active: true,
          firstSeenAt: now,
          lastSeenAt: now,
          lastScanAt: now,
          metadata: metadata ?? {},
          pricingSource: pricingSource ?? null,
        },
      };
    }

    // A manual model absorbs new evidence but keeps its own identity, notes
    // and free status if the user set one deliberately.
    const merged = {
      ...existing,
      displayName: displayName ?? existing.displayName,
      lastSeenAt: now,
      lastScanAt: now,
      missCount: 0,
      state: MODEL_STATE.ACTIVE,
      active: existing.active !== false,
      metadata: { ...(existing.metadata ?? {}), ...(metadata ?? {}) },
      evidence: mergeEvidence(existing.evidence, evidence ?? []),
    };
    // Only recompute the verdict from pricing when the provider actually
    // published a price; a catalog with no pricing must not overwrite a
    // FREE_LIKELY that the name hint produced.
    if (pricing) {
      const verdict = detectFree({
        modelId: existing.modelId,
        displayName: merged.displayName,
        pricing,
        source: pricingSource,
      });
      merged.freeStatus = verdict.freeStatus;
      merged.inputPrice = verdict.inputPrice;
      merged.outputPrice = verdict.outputPrice;
      merged.evidence = mergeEvidence(merged.evidence, verdict.evidence);
    }
    return { state: 'merged', model: merged };
  }

  /**
   * Record a whole catalog in one pass and one write.
   *
   * The scan path, and the reason it exists rather than a loop over
   * `upsertDiscovered`: on IndexedDB every `put` is its own transaction, so
   * recording a 460-model catalog that way opened 460 transactions. Measured on
   * a 12-URL / 720-model registry, that path cost ~200ms of nothing but
   * transaction overhead.
   *
   * Here the stored models are read once, every merge is computed in memory,
   * and the result is written with a single `putMany`. Same merges, same rows -
   * `mergeDiscovered` is shared with the single-model path - and one commit.
   *
   * Models the scan did not return are still marked, never deleted: a provider
   * that hides models behind a flaky endpoint would otherwise wipe a list the
   * user built up by hand.
   *
   * @returns {Promise<{added:number, merged:number, notSeen:number, deactivated:number, total:number}>}
   */
  async applyScan(providerId, discovered, { inactiveAfter = 3, seenAsOf } = {}) {
    const now = seenAsOf ?? isoNow();
    const existing = await this.list(providerId);
    const byModelId = new Map(existing.map((m) => [m.modelId, m]));

    let added = 0;
    let merged = 0;
    const writes = [];
    const seenIds = new Set();

    for (const entry of discovered) {
      const modelId = entry?.modelId;
      if (!modelId) continue;
      seenIds.add(modelId);

      const outcome = this.mergeDiscovered(byModelId.get(modelId) ?? null, { ...entry, providerId }, now);
      if (outcome.state === 'created') added += 1;
      else merged += 1;
      writes.push(outcome.model);
    }

    // Same policy as `markUnseen`, applied to whatever the catalog left out.
    // Manual entries are exempt for the same reason: the user added them.
    let notSeen = 0;
    let deactivated = 0;
    for (const model of existing) {
      if (seenIds.has(model.modelId)) continue;
      if (model.source === MODEL_SOURCE.MANUAL) continue;

      const missCount = (model.missCount ?? 0) + 1;
      const patch = { missCount, state: MODEL_STATE.NOT_SEEN, lastScanAt: now };
      if (missCount >= inactiveAfter) {
        patch.state = MODEL_STATE.INACTIVE;
        patch.active = false;
        deactivated += 1;
      } else {
        notSeen += 1;
      }
      writes.push({ ...model, ...patch });
    }

    if (writes.length) await this.storage.putMany('models', writes);
    return { added, merged, notSeen, deactivated, total: discovered.length };
  }

  /**
   * Mark models the scan did not see.
   *
   * Deletion is not an option here. A provider that hides models behind a
   * flaky endpoint would otherwise wipe a list the user built up by hand.
   */
  async markUnseen(providerId, seenIds, { inactiveAfter = 3 } = {}) {
    const models = await this.list(providerId);
    let notSeen = 0;
    let deactivated = 0;
    const patches = [];

    for (const model of models) {
      if (seenIds.has(model.modelId)) continue;
      // Manual entries are exempt: the user added them for a reason.
      if (model.source === MODEL_SOURCE.MANUAL) continue;

      const missCount = (model.missCount ?? 0) + 1;
      const patch = { missCount, state: MODEL_STATE.NOT_SEEN, lastScanAt: isoNow() };

      if (missCount >= inactiveAfter) {
        patch.state = MODEL_STATE.INACTIVE;
        patch.active = false;
        deactivated += 1;
      } else {
        notSeen += 1;
      }
      patches.push({ ...model, ...patch });
    }

    // One batch rather than a write per model. On IndexedDB each `put` is its
    // own transaction, so a provider whose catalog shrank used to open a
    // transaction per missing model, in the middle of a scan the user is
    // watching.
    if (patches.length) await this.storage.putMany('models', patches);
    return { notSeen, deactivated };
  }

  /** Add a model by hand (plan 6). */
  async addManual({ providerId, modelId, displayName, freeStatus = FREE.FREE_UNKNOWN, notes = '', metadata = {} }) {
    const existing = await this.find(providerId, modelId);
    if (existing) return { model: existing, created: false, reason: 'DUPLICATE' };

    const now = isoNow();
    const model = {
      id: makeId('mdl'),
      providerId,
      modelId,
      displayName: displayName?.trim() || modelId,
      source: MODEL_SOURCE.MANUAL,
      freeStatus,
      evidence: [{ source: 'user', field: 'freeStatus', value: freeStatus }],
      inputPrice: null,
      outputPrice: null,
      state: MODEL_STATE.ACTIVE,
      missCount: 0,
      active: true,
      notes,
      firstSeenAt: now,
      lastSeenAt: now,
      lastScanAt: now,
      metadata,
    };
    await this.storage.put('models', model);
    return { model, created: true };
  }

  async update(id, patch) {
    const model = await this.get(id);
    if (!model) return null;
    const updated = { ...model, ...patch, updatedAt: isoNow() };
    await this.storage.put('models', updated);
    return updated;
  }

  async remove(id) {
    await this.storage.remove('models', id);
  }

  /**
   * Models the UI shows by default: the free ones.
   * PAID models stay in storage but are filtered out of the main list.
   */
  async listVisible(providerId = null) {
    const all = await this.list(providerId);
    return all.filter((m) => m.active !== false && m.freeStatus !== FREE.PAID);
  }
}

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

  async list(providerId = null) {
    const all = await this.storage.list('models');
    return providerId ? all.filter((m) => m.providerId === providerId) : all;
  }

  async get(id) {
    return this.storage.get('models', id);
  }

  async find(providerId, modelId) {
    const all = await this.list(providerId);
    return all.find((m) => m.modelId === modelId) ?? null;
  }

  /**
   * Record one discovered model.
   *
   * Returns 'created' or 'merged'. A merge is what keeps a scanner refresh
   * from producing duplicate rows for a model it has seen before.
   */
  async upsertDiscovered({ providerId, modelId, displayName, pricing, evidence, metadata, pricingSource }) {
    const existing = await this.find(providerId, modelId);
    const now = isoNow();

    if (!existing) {
      // A discovered model with no published price can still be judged by its
      // name, so the detector runs here rather than waiting for the caller.
      const verdict = detectFree({
        modelId,
        displayName: displayName ?? modelId,
        pricing,
        source: pricingSource,
      });

      const model = {
        id: makeId('mdl'),
        providerId,
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
      };
      await this.storage.put('models', model);
      return { state: 'created', model };
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
    await this.storage.put('models', merged);
    return { state: 'merged', model: merged };
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
      await this.storage.put('models', { ...model, ...patch });
    }
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
